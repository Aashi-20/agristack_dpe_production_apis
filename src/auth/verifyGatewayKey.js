const crypto = require('crypto');
const { sendError } = require('../utils/apiError');

// Guards the gateway-only door (POST /dpe/internal/v2/seek), which the
// central APISIX calls after routing an AIU's request to this state. The
// AIU never sees or sends this key: APISIX adds it on the way in, and this
// app only accepts the internal endpoint when it matches.
//
// GATEWAY_API_KEYS is a comma-separated LIST, not a single value, so a key
// can be rotated without downtime: add the new key alongside the old one,
// update APISIX to send the new one, then remove the old one.
//
// Compared via SHA-256 digests with timingSafeEqual (fixed-length inputs,
// no early exit across the configured keys), so response timing can't be
// used to guess a key character by character.

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function configuredKeys() {
  return (process.env.GATEWAY_API_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

function keyIsValid(presented) {
  const presentedDigest = sha256(presented);
  let matched = false;
  for (const key of configuredKeys()) {
    if (crypto.timingSafeEqual(presentedDigest, sha256(key))) {
      matched = true; // no break: always compare against every key
    }
  }
  return matched;
}

function verifyGatewayKey(req, res, next) {
  const presented = req.headers['x-api-key'];
  if (!presented) {
    return sendError(res, 401, 'MISSING_API_KEY', 'Missing X-API-Key header');
  }
  // If no keys are configured this always fails -- the route isn't even
  // registered in that case (see index.js), this is just a second lock.
  if (!keyIsValid(presented)) {
    console.warn('[gateway] Rejected: X-API-Key did not match any configured key.');
    return sendError(res, 401, 'INVALID_API_KEY', 'Invalid API key');
  }
  next();
}

// Misrouting guard. Each state deployment knows its own LGD code
// (STATE_LGD_CODE). If APISIX is ever misconfigured and sends Kerala's
// request to Telangana's app, this rejects it here instead of quietly
// answering from the wrong state's data. Skipped when STATE_LGD_CODE isn't
// set, so it can be adopted state by state.
function verifyGatewayState(req, res, next) {
  const expected = (process.env.STATE_LGD_CODE || '').trim();
  if (!expected) return next();

  const presented = String(req.headers['x-state-lgd-code'] || '').trim();
  if (!presented) {
    return sendError(res, 400, 'MISSING_STATE_CODE', 'Missing X-State-LGD-Code header');
  }
  if (presented !== expected) {
    console.warn(`[gateway] Rejected: request is for state LGD ${presented}, this deployment serves ${expected}.`);
    return sendError(res, 400, 'STATE_MISMATCH', `This deployment serves state LGD code ${expected}, not ${presented}`);
  }
  next();
}

module.exports = { verifyGatewayKey, verifyGatewayState };
