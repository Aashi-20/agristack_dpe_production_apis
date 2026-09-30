const clickhouse = require('../db/clickhouse');
const { DATA_SHARING_DB } = require('../db/dataSharingDb');
const { getRedisClient } = require('../db/redisClient');

// Whether a service_id uses the SD-JWT credential flow (resolveSdjwtSeek.js)
// instead of the normal GraphQL-backed flow (resolveSeekResponse.js). A row
// present in aiu_sdjwt_config means "yes" -- no row means "no, use the
// normal flow". This is checked per service_id only, matching the decision
// to scope this by service_id rather than by sender_id+service_id pair.
//
// REDIS: key "dpe:config:sdjwt_service:<service_id>". Value "1" or "0",
// both cached, so an unflagged (the vast majority of) service_ids don't
// hit ClickHouse on every request either. TTL: CONFIG_CACHE_TTL_MS, same
// as the other admin-managed config lookups (aiu_service_config etc.).
const TABLE_SUFFIX = process.env.TELEMETRY_TABLE_SUFFIX ?? '_dist';
const TABLE = `${DATA_SHARING_DB}.aiu_sdjwt_config${TABLE_SUFFIX}`;
const CACHE_TTL_SECONDS = Math.ceil(Number(process.env.CONFIG_CACHE_TTL_MS || 24 * 60 * 60 * 1000) / 1000);

function keyFor(serviceId) {
  return `dpe:config:sdjwt_service:${serviceId}`;
}

async function isSdjwtService(serviceId) {
  if (!serviceId) return false;

  const redis = await getRedisClient();
  const cached = await redis.get(keyFor(serviceId));
  if (cached !== null) {
    console.log(`[redis] Cache hit: sdjwt_service:${serviceId} (enabled=${cached === '1'})`);
    return cached === '1';
  }
  console.log(`[redis] Cache miss: sdjwt_service:${serviceId} -- querying ClickHouse`);

  const result = await clickhouse.query({
    query: `SELECT count() AS c FROM ${TABLE} WHERE service_id = {serviceId:String}`,
    query_params: { serviceId },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  const enabled = Number(rows[0]?.c || 0) > 0;

  await redis.set(keyFor(serviceId), enabled ? '1' : '0', { EX: CACHE_TTL_SECONDS });
  return enabled;
}

module.exports = { isSdjwtService };
