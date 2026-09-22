// The separate ClickHouse database holding every table THIS application
// created (config, dedup, learned mappings, telemetry/audit, public keys).
// Deliberately separate from CLICKHOUSE_DB (db/clickhouse.js's default
// connection database), which still holds the pre-existing
// farmer_demographic/land/land_ownership tables fed by materialized views
// this app doesn't own -- those are NOT part of this split.
const DATA_SHARING_DB = process.env.CLICKHOUSE_DATA_SHARING_DB || 'dpe_data_sharing';

module.exports = { DATA_SHARING_DB };
