const crypto = require('crypto');
const { decodeJwtPayload } = require('./jwt');
const { getRedisClient } = require('../db/redisClient');

// Caches introspection RESULTS (is_valid true/false) per bearer token, so a
// given AIU calling the same token repeatedly doesn't hit the real Network
// Manager introspect API on every single request.
//
// REDIS: key "dpe:auth:introspect:<sha256 of the token>". Value is the
// JSON-stringified { is_valid, message } result. Tokens are hashed before
// use as the key so the raw bearer token itself isn't stored as a visible
// Redis key name.
//
// TTL is derived from the token's OWN real expiry (its "exp" claim) rather
// than a flat guess -- we cache the answer for exactly as long as the token
// itself claims to still be valid, never longer. TOKEN_INTROSPECT_CACHE_TTL_MS
// now acts as a CAP/fallback: if a token's real remaining lifetime is
// shorter than the cap, we use the token's real lifetime; if a token is
// somehow unreadable (no exp claim, malformed), we fall back to this value.
// Default cap is 12 hours, matching this Network Manager's actual token
// lifetime -- so in practice we simply cache until the token expires, and
// Redis deletes the key itself once that TTL passes (no manual cleanup
// needed, unlike the old in-memory version's periodic sweep).
//
// SECURITY TRADE-OFF, still real even with this improvement: if the Network
// Manager revokes a token EARLY (before its own exp), we'd keep accepting
// it until the Redis key expires, since we're trusting our own cache
// instead of asking again. This is bounded by the token's real lifetime
// rather than an arbitrary flat number, but it's not eliminated -- confirm
// this window is acceptable for your use case.
const MAX_TTL_MS = Number(process.env.TOKEN_INTROSPECT_CACHE_TTL_MS || 12 * 60 * 60 * 1000);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function keyFor(token) {
  return `dpe:auth:introspect:${hashToken(token)}`;
}

// How long to actually cache this specific token's result: the smaller of
// (a) its own real remaining lifetime, and (b) the configured cap.
function computeTtlSeconds(token) {
  const payload = decodeJwtPayload(token);
  if (payload?.exp) {
    const remainingMs = payload.exp * 1000 - Date.now();
    if (remainingMs > 0) {
      return Math.max(Math.ceil(Math.min(remainingMs, MAX_TTL_MS) / 1000), 1);
    }
  }
  // No readable exp claim -- fall back to the cap so we still cache
  // *something* rather than never caching at all.
  return Math.ceil(MAX_TTL_MS / 1000);
}

async function getCachedResult(token) {
  const redis = await getRedisClient();
  const raw = await redis.get(keyFor(token));
  if (!raw) return null;
  return JSON.parse(raw);
}

async function setCachedResult(token, result) {
  const redis = await getRedisClient();
  const ttlSeconds = computeTtlSeconds(token);
  await redis.set(keyFor(token), JSON.stringify(result), { EX: ttlSeconds });
}

module.exports = { getCachedResult, setCachedResult };
