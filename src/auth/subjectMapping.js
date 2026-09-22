const clickhouse = require('../db/clickhouse');
const { DATA_SHARING_DB } = require('../db/dataSharingDb');
const { getRedisClient } = require('../db/redisClient');

// Learned mapping from a token's "sub" claim to the sender_id it actually
// belongs to. ClickHouse (known_aiu_token_subject) is the durable, permanent
// record -- Redis is purely a fast read-through CACHE in front of it, not a
// replacement for it. Populated only from real, successful introspect calls
// -- see verifyTokenMiddleware.js. This exists because the token itself
// does NOT carry sender_id as a claim (confirmed empirically: a real
// token's "sub" did not equal its known sender_id), so local validation has
// no other way to check AIU identity without either this learned mapping
// or a real introspect call every time.
//
// REDIS: key "dpe:auth:subject_map:<sub>". Value is the sender_id string,
// or an empty string as a sentinel meaning "we checked ClickHouse and
// confirmed there's no mapping yet" (distinct from a Redis cache MISS,
// which means we haven't checked at all and need to query ClickHouse).
// TTL: CONFIG_CACHE_TTL_MS, default 24 hours -- this data is effectively
// permanent once confirmed, so a long cache is safe; a mapping learned via
// introspect right before this expires just means the next check re-reads
// the same answer from ClickHouse, which is cheap.
const TABLE_SUFFIX = process.env.TELEMETRY_TABLE_SUFFIX ?? '_dist';
const TABLE = `${DATA_SHARING_DB}.known_aiu_token_subject${TABLE_SUFFIX}`;
const CACHE_TTL_SECONDS = Math.ceil(Number(process.env.CONFIG_CACHE_TTL_MS || 24 * 60 * 60 * 1000) / 1000);

function keyFor(sub) {
  return `dpe:auth:subject_map:${sub}`;
}

async function getKnownSenderIdForSubject(sub) {
  const redis = await getRedisClient();
  const cached = await redis.get(keyFor(sub));
  if (cached !== null) {
    console.log(`[redis] Cache hit: subject_map:${sub}`);
    return cached === '' ? null : cached;
  }
  console.log(`[redis] Cache miss: subject_map:${sub} -- querying ClickHouse`);

  const result = await clickhouse.query({
    query: `SELECT sender_id FROM ${TABLE} WHERE sub = {sub:String} ORDER BY confirmed_at DESC LIMIT 1`,
    query_params: { sub },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  const senderId = rows[0]?.sender_id || null;

  await redis.set(keyFor(sub), senderId ?? '', { EX: CACHE_TTL_SECONDS });
  return senderId;
}

async function recordConfirmedSubject(sub, senderId) {
  await clickhouse.insert({
    table: TABLE,
    values: [{ sub, sender_id: senderId }],
    format: 'JSONEachRow',
  });
  const redis = await getRedisClient();
  await redis.set(keyFor(sub), senderId, { EX: CACHE_TTL_SECONDS });
  console.log(`[redis] Cached subject_map:${sub} -> ${senderId} for ${CACHE_TTL_SECONDS}s.`);
}

module.exports = { getKnownSenderIdForSubject, recordConfirmedSubject };
