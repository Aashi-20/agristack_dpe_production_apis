// Decodes a JWT's payload WITHOUT verifying its signature. This is safe to
// do freely -- reading the claims doesn't require the public key, only
// checking the signature does. Used to read a token's own real expiry
// (exp) so caching durations track the actual token instead of a guess.
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(payloadB64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

module.exports = { decodeJwtPayload };
