const { createClient } = require('@clickhouse/client');

// Single shared ClickHouse client used by every profile resolver.
// All reads hit the Distributed tables (*_dist), never the shards directly.
const clickhouse = createClient({
  host: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER || 'default',
  password: process.env.CLICKHOUSE_PASSWORD || '',
  database: process.env.CLICKHOUSE_DB || 'dpe_db',
});

module.exports = clickhouse;
