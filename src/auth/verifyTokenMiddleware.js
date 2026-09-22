const { introspectToken } = require('./introspect');
const { getCachedResult, setCachedResult } = require('./introspectCache');
const { verifyJwtLocally } = require('./verifyJwtLocally');
const { getKnownSenderIdForSubject, recordConfirmedSubject } = require('./subjectMapping');
const { decodeJwtPayload } = require('./jwt');
const { sendError } = require('../utils/apiError');

// Express middleware: verifies the caller's Bearer token before a seek
// request is allowed to proceed. Runs in front of both the sync (v2) and
// async (v1) seek routes.
//
// Controlled by USE_LOCAL_TOKEN_VALIDATION (true/false):
//
// false (default): calls the real Network Manager introspect API every
// time, cached per-token (introspectCache.js). Every successful check also
// records the token's sub -> sender_id pairing in subjectMapping.js, so
// that knowledge accumulates automatically just from normal use -- by the
// time USE_LOCAL_TOKEN_VALIDATION=true is turned on, real mappings likely
// already exist.
//
// true: verifies the token locally (verifyJwtLocally.js -- currently
// expiry-only, since there's no public key yet; upgrades to full signature
// verification automatically the moment NM_JWKS_URL is set, no other
// change needed). For the AIU-identity check, looks up the token's "sub" in
// the learned mapping (subjectMapping.js). A known, matching sub/sender_id
// pair passes with NO network call at all. An unknown or mismatched pair
// falls back to ONE real introspect call to confirm/learn it (never
// blindly trusts an unconfirmed pairing), then remembers it for next time.
async function verifyToken(req, res, next) {
  const mode = process.env.USE_LOCAL_TOKEN_VALIDATION === 'true' ? 'local' : 'introspect';

  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const senderId = req.body?.header?.sender_id;

    if (!token) {
      return sendError(res, 401, 'MISSING_TOKEN', 'Missing Authorization: Bearer <token> header');
    }
    if (!senderId) {
      return sendError(res, 400, 'MISSING_SENDER_ID', 'Missing header.sender_id in request body');
    }

    console.log(`[auth] Verifying token for sender_id=${senderId} (mode=${mode})`);

    if (mode === 'local') {
      const localResult = await verifyJwtLocally(token);
      if (!localResult.is_valid) {
        console.log(`[auth] Local expiry/signature check FAILED for sender_id=${senderId}: ${localResult.message}`);
        return sendError(res, 401, 'INVALID_TOKEN', localResult.message);
      }
      console.log(`[auth] Local expiry/signature check passed for sender_id=${senderId}`);

      const sub = localResult.payload.sub;
      const knownSenderId = await getKnownSenderIdForSubject(sub);

      if (knownSenderId === senderId) {
        console.log(`[auth] sub=${sub} already mapped to sender_id=${senderId} -- skipping introspect call.`);
        return next();
      }

      console.log(`[auth] sub=${sub} not yet mapped to sender_id=${senderId} -- calling introspect API once to confirm.`);
      const introspectResult = await introspectToken(token, senderId);
      if (introspectResult.is_valid) {
        await recordConfirmedSubject(sub, senderId);
        console.log(`[auth] Introspect confirmed the mapping -- saved for future requests from sender_id=${senderId}.`);
        return next();
      }
      console.log(`[auth] Introspect REJECTED the token for sender_id=${senderId}: ${introspectResult.message}`);
      return sendError(res, 401, 'INVALID_TOKEN', introspectResult.message || 'Token failed introspection');
    }

    // Default: real introspect API, with caching.
    const cached = await getCachedResult(token);
    if (cached) {
      console.log(`[auth] Cached introspection result found for sender_id=${senderId} (is_valid=${cached.is_valid}) -- skipping introspect call.`);
      if (!cached.is_valid) {
        return sendError(res, 401, 'INVALID_TOKEN', cached.message || 'Token failed introspection');
      }
      return next();
    }

    console.log(`[auth] No cached result for sender_id=${senderId} -- calling introspect API.`);
    const result = await introspectToken(token, senderId);
    await setCachedResult(token, result);

    if (!result.is_valid) {
      console.log(`[auth] Introspect REJECTED the token for sender_id=${senderId}: ${result.message}`);
      return sendError(res, 401, 'INVALID_TOKEN', result.message || 'Token failed introspection');
    }
    console.log(`[auth] Introspect confirmed the token for sender_id=${senderId} -- result cached.`);

    // Opportunistically learn the sub -> sender_id mapping from this real,
    // confirmed check, for local mode to use later. Never blocks the
    // request if this fails for some reason.
    const payload = decodeJwtPayload(token);
    if (payload?.sub) {
      recordConfirmedSubject(payload.sub, senderId).catch((err) => {
        console.error('[auth] Failed to record subject mapping (non-fatal):', err.message);
      });
    }

    next();
  } catch (err) {
    console.error(`[auth] Verification error: ${err.message}`);
    return sendError(res, 502, 'AUTH_SERVICE_UNAVAILABLE', `Token verification failed: ${err.message}`);
  }
}

module.exports = { verifyToken };
