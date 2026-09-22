const clickhouse = require('../db/clickhouse');
const { DATA_SHARING_DB } = require('../db/dataSharingDb');
const { getRedisClient } = require('../db/redisClient');

// Checks whether header.sender_id is actually allowed to use a given
// service_id, per aiu_sender_service_map. Without this check, a
// service_id alone would be enough to get that service's attribute
// permissions, regardless of who the caller actually is.
//
// REDIS: key "dpe:config:sender_service_map:<sender_id>:<service_id>".
// Value is the string "1" (allowed) or "0" (not allowed) -- both outcomes
// are cached, so a request from an unauthorized sender_id doesn't hammer
// ClickHouse on every retry either. TTL: CONFIG_CACHE_TTL_MS, default 24
// hour -- same reasoning as serviceConfig.js, this is admin-managed data
// that changes rarely.
const TABLE_SUFFIX = process.env.TELEMETRY_TABLE_SUFFIX ?? '_dist';
const TABLE = `${DATA_SHARING_DB}.aiu_sender_service_map${TABLE_SUFFIX}`;
const CACHE_TTL_SECONDS = Math.ceil(Number(process.env.CONFIG_CACHE_TTL_MS || 24 * 60 * 60 * 1000) / 1000);

function keyFor(senderId, serviceId) {
  return `dpe:config:sender_service_map:${senderId}:${serviceId}`;
}

async function isSenderMappedToService(senderId, serviceId) {
  if (!senderId || !serviceId) return false;

  const redis = await getRedisClient();
  const cacheKey = keyFor(senderId, serviceId);
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    console.log(`[redis] Cache hit: sender_service_map:${senderId}:${serviceId} (allowed=${cached === '1'})`);
    return cached === '1';
  }
  console.log(`[redis] Cache miss: sender_service_map:${senderId}:${serviceId} -- querying ClickHouse`);

  const result = await clickhouse.query({
    query: `SELECT count() AS c FROM ${TABLE} WHERE sender_id = {senderId:String} AND service_id = {serviceId:String}`,
    query_params: { senderId, serviceId },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  const allowed = Number(rows[0]?.c || 0) > 0;

  await redis.set(cacheKey, allowed ? '1' : '0', { EX: CACHE_TTL_SECONDS });
  return allowed;
}

module.exports = { isSenderMappedToService };
