const fetch = require('node-fetch');
const { getRedisClient } = require('../db/redisClient');

// Our own service-account token, used only to call the Network Manager's
// introspect API (not the AIU's token -- that's the one we're checking).
//
// REDIS: key "dpe:auth:nm_service_token", one single key (there's only one
// of "us", so no per-entity part to the key). Redis's own TTL does the
// expiry -- once it's set with an EX, Redis deletes it automatically at
// that point; there's no need to separately track "when to refresh" the
// way the old in-memory version did with a second variable.
// TTL: the token's own real expires_in, minus a 30s safety margin (so a
// request never gets caught using a token that expires mid-flight);
// 5 minutes if expires_in is missing from the Network Manager's response.
const TOKEN_KEY = 'dpe:auth:nm_service_token';

async function fetchServiceToken() {
  if (!process.env.NM_TOKEN_URL || !process.env.NM_USERNAME || !process.env.NM_PASSWORD) {
    throw new Error(
      'NM_TOKEN_URL, NM_USERNAME, and NM_PASSWORD must all be set in .env to authenticate against the Network Manager.'
    );
  }

  const redis = await getRedisClient();
  const cached = await redis.get(TOKEN_KEY);
  if (cached) {
    console.log('[redis] Cache hit: nm_service_token -- skipping login to Network Manager.');
    return cached;
  }
  console.log('[redis] Cache miss: nm_service_token -- logging into Network Manager.');

  const params = new URLSearchParams();
  params.append('client_id', process.env.NM_CLIENT_ID || 'registry-frontend');
  params.append('username', process.env.NM_USERNAME);
  params.append('password', process.env.NM_PASSWORD);
  params.append('grant_type', 'password');

  const res = await fetch(process.env.NM_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const json = await res.json();
  if (!json.access_token) {
    if (json.error === 'invalid_grant') {
      throw new Error(
        `Network Manager rejected NM_USERNAME/NM_PASSWORD in .env (invalid_grant: ${json.error_description || 'invalid credentials'}). ` +
        `This is a credentials problem, not a code problem -- verify NM_USERNAME/NM_PASSWORD in .env are correct by testing the ` +
        `token API directly with curl outside this app, using the exact same values.`
      );
    }
    throw new Error(`Failed to fetch service token from Network Manager: ${JSON.stringify(json)}`);
  }

  const ttlSeconds = json.expires_in ? Math.max(json.expires_in - 30, 1) : 5 * 60;
  await redis.set(TOKEN_KEY, json.access_token, { EX: ttlSeconds });
  console.log(`[redis] Cached nm_service_token for ${ttlSeconds}s.`);

  return json.access_token;
}

module.exports = { fetchServiceToken };
