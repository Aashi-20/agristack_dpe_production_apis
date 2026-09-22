const clickhouse = require('../db/clickhouse');
const { DATA_SHARING_DB } = require('../db/dataSharingDb');
const { getRedisClient } = require('../db/redisClient');

// service config lives in ClickHouse (aiu_service_config -- see
// clickhouse/telemetry_tables.sql) instead of a hardcoded object, so an
// AIU's allowed attributes can be changed without a code deploy.
//
// No separate purpose_code column -- service_name doubles as the purpose
// label when one is needed (nothing downstream reads a distinct purpose
// value from config today; the event's own purposeCode comes from the
// AIU's request itself, in eventBuilder.js, not from config).
//
// REDIS: key "dpe:config:service:<service_id>". Value is the
// JSON-stringified config object (or the literal string "null" if that
// service_id doesn't exist -- caching the "not found" answer too, so a
// request for a nonexistent service_id doesn't hammer ClickHouse
// repeatedly). TTL: CONFIG_CACHE_TTL_MS, default 24 hours -- this data is
// admin-managed and changes rarely, so a long cache is safe. A config
// change can take up to this long to actually start applying; shorten
// CONFIG_CACHE_TTL_MS if you need changes to land faster, or manually
// delete the Redis key for that one service_id to clear it immediately.
const TABLE_SUFFIX = process.env.TELEMETRY_TABLE_SUFFIX ?? '_dist';
const TABLE = `${DATA_SHARING_DB}.aiu_service_config${TABLE_SUFFIX}`;
const CACHE_TTL_SECONDS = Math.ceil(Number(process.env.CONFIG_CACHE_TTL_MS || 24 * 60 * 60 * 1000) / 1000);

function keyFor(serviceId) {
  return `dpe:config:service:${serviceId}`;
}

// Turns the 1-row-per-profile ClickHouse rows for one service_id back into
// the { aiuServiceId, aiuServiceName, dataProfiles: { farmerData: [...], ... } }
// shape the rest of the codebase (resolveSeekResponse.js etc.) already
// expects -- so nothing downstream needed to change for this migration.
function rowsToConfig(rows) {
  if (!rows.length) return null;
  const dataProfiles = {};
  for (const row of rows) {
    dataProfiles[row.profile_key] = row.allowed_attributes;
  }
  return {
    aiuServiceId: rows[0].service_id,
    aiuServiceName: rows[0].service_name,
    purposeCode: rows[0].service_name, // no dedicated column -- service_name doubles as this
    dataProfiles,
  };
}

async function getServiceConfig(serviceId) {
  if (!serviceId) return null;

  const redis = await getRedisClient();
  const cached = await redis.get(keyFor(serviceId));
  if (cached !== null) {
    console.log(`[redis] Cache hit: service:${serviceId}`);
    return JSON.parse(cached);
  }
  console.log(`[redis] Cache miss: service:${serviceId} -- querying ClickHouse`);

  const result = await clickhouse.query({
    query: `SELECT service_id, service_name, profile_key, allowed_attributes FROM ${TABLE} WHERE service_id = {serviceId:String}`,
    query_params: { serviceId },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  const config = rowsToConfig(rows);

  await redis.set(keyFor(serviceId), JSON.stringify(config), { EX: CACHE_TTL_SECONDS });
  return config;
}

module.exports = { getServiceConfig };
