const clickhouse = require('../db/clickhouse');
const { DATA_SHARING_DB } = require('../db/dataSharingDb');
const { getRedisClient } = require('../db/redisClient');

// Looks up an AIU's registered public key by sender_id.
//
// REDIS: key "dpe:encryption:public_key:<sender_id>". Value is the PEM
// public key string, or an empty string sentinel meaning "checked
// ClickHouse, this AIU has no registered key" (distinct from a cache MISS,
// which means we haven't checked yet). TTL: CONFIG_CACHE_TTL_MS, default 24
// hour -- keys change rarely (only on registration or rotation), so a long
// cache is safe.
const TABLE_SUFFIX = process.env.TELEMETRY_TABLE_SUFFIX ?? '_dist';
const TABLE = `${DATA_SHARING_DB}.aiu_public_key${TABLE_SUFFIX}`;
const CACHE_TTL_SECONDS = Math.ceil(Number(process.env.CONFIG_CACHE_TTL_MS || 24 * 60 * 60 * 1000) / 1000);

function keyFor(senderId) {
  return `dpe:encryption:public_key:${senderId}`;
}

async function getAiuPublicKey(senderId) {
  const redis = await getRedisClient();
  const cached = await redis.get(keyFor(senderId));
  if (cached !== null) {
    console.log(`[redis] Cache hit: public_key:${senderId}`);
    return cached === '' ? null : cached;
  }
  console.log(`[redis] Cache miss: public_key:${senderId} -- querying ClickHouse`);

  const result = await clickhouse.query({
    query: `SELECT public_key FROM ${TABLE} WHERE sender_id = {senderId:String} ORDER BY registered_at DESC LIMIT 1`,
    query_params: { senderId },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  const publicKey = rows[0]?.public_key || null;

  await redis.set(keyFor(senderId), publicKey ?? '', { EX: CACHE_TTL_SECONDS });
  return publicKey;
}

module.exports = { getAiuPublicKey };
