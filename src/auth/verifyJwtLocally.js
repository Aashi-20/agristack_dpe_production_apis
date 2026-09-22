const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { decodeJwtPayload } = require('./jwt');

// Keycloak's admin console "Public key" button gives you the raw base64
// key data WITHOUT the PEM wrapper Node's crypto library requires. This
// adds that wrapper: strips any stray whitespace/newlines you might have
// pasted along with it, re-wraps at the standard 64-char line length, and
// adds the BEGIN/END markers. Paste exactly what Keycloak showed you into
// NM_PUBLIC_KEY -- this function does the rest.
function toPemPublicKey(rawBase64) {
  const cleaned = rawBase64.replace(/\s+/g, '');
  const lines = cleaned.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

// Fetches and caches the Network Manager's public signing key(s) from its
// JWKS endpoint. Only constructed if NM_JWKS_URL is set -- this is the
// fallback path used when NM_PUBLIC_KEY isn't set directly (see below).
let client = null;
if (process.env.NM_JWKS_URL) {
  client = jwksClient({
    jwksUri: process.env.NM_JWKS_URL,
    cache: true,
    cacheMaxAge: 12 * 60 * 60 * 1000, // 12h, matches token lifetime
    rateLimit: true,
  });
}

function getSigningKeyFromJwks(kid) {
  return new Promise((resolve, reject) => {
    client.getSigningKey(kid, (err, key) => {
      if (err) return reject(err);
      resolve(key.getPublicKey());
    });
  });
}

// Verifies ONLY what a JWT can actually prove on its own: that it hasn't
// expired, and (once a public key is available, in either form below) that
// it was genuinely signed by the Network Manager. Does NOT check AIU
// identity -- a real, decoded token showed its "sub" claim does not equal
// its known sender_id, so no claim inside the token answers "was this
// issued to this AIU." That check lives in subjectMapping.js instead (see
// verifyTokenMiddleware.js for how the two combine).
//
// THREE PATHS, checked in this order:
//
// 1. NM_PUBLIC_KEY set (what you have right now): uses that exact key
//    directly for real cryptographic signature verification. No network
//    call, no key rotation handling -- if UFSI ever rotates their signing
//    key, this stops working until you update NM_PUBLIC_KEY by hand.
//
// 2. NM_JWKS_URL set (better long-term, once reachable): fetches the
//    public key from the live JWKS endpoint, matched by the token's "kid"
//    header. Handles key rotation automatically. Same verification math as
//    path 1, just where the key comes from differs.
//
// 3. Neither set (today's fallback): decodes the token WITHOUT verifying
//    its signature, checking only the "exp" claim. Explicitly weaker: a
//    forged token with a future exp would pass this path. Logs a warning
//    every time so this is never silently mistaken for the real thing.
async function verifyJwtLocally(token) {
  console.log('[auth] Decoding JWT header to find the signing key id (kid)...');
  const decodedHeader = jwt.decode(token, { complete: true });
  if (!decodedHeader) {
    return { is_valid: false, message: 'Token is not a well-formed JWT' };
  }

  let publicKey = null;

  if (process.env.NM_PUBLIC_KEY) {
    console.log('[auth] Using the configured static public key (NM_PUBLIC_KEY) -- no network call.');
    publicKey = toPemPublicKey(process.env.NM_PUBLIC_KEY);
  } else if (process.env.NM_JWKS_URL) {
    console.log(`[auth] Fetching public key from JWKS endpoint for kid=${decodedHeader.header.kid}...`);
    try {
      publicKey = await getSigningKeyFromJwks(decodedHeader.header.kid);
    } catch (err) {
      console.log(`[auth] Could not fetch signing key from JWKS: ${err.message}`);
      return { is_valid: false, message: `Could not fetch signing key: ${err.message}` };
    }
  }

  if (!publicKey) {
    console.warn('[auth] No NM_PUBLIC_KEY or NM_JWKS_URL configured -- verifying expiry only, WITHOUT signature verification.');
    const payload = decodeJwtPayload(token);
    if (!payload) {
      return { is_valid: false, message: 'Token is not a well-formed JWT' };
    }
    if (!payload.exp) {
      return { is_valid: false, message: 'Token has no exp claim to check' };
    }
    if (Date.now() >= payload.exp * 1000) {
      console.log('[auth] Token exp has passed -- expired.');
      return { is_valid: false, message: 'Token is expired' };
    }
    console.log('[auth] Token exp is in the future -- treating as valid (signature NOT checked).');
    return { is_valid: true, message: 'Token expiry checked locally (signature NOT verified -- no public key configured yet)', payload };
  }

  console.log('[auth] Verifying signature (RS256), expiry, and issuer against the public key...');
  try {
    const payload = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: process.env.NM_EXPECTED_ISSUER || undefined,
    });
    console.log('[auth] Signature verified -- this token was genuinely issued by UFSI (or whoever holds the matching private key), and is not expired.');
    return { is_valid: true, message: 'Token signature/expiry/issuer verified locally', payload };
  } catch (err) {
    // Covers expired (TokenExpiredError), bad signature (JsonWebTokenError),
    // and wrong issuer (also JsonWebTokenError) in one place.
    console.log(`[auth] Signature/expiry/issuer check FAILED: ${err.message}`);
    return { is_valid: false, message: `Token verification failed: ${err.message}` };
  }
}

module.exports = { verifyJwtLocally };
