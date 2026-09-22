const fetch = require('node-fetch');

// Each profile has its own running GraphQL API. They're mounted on the same
// Express app at different paths for now (see src/index.js) -- but because
// this calls them over HTTP by URL, splitting any one of them into its own
// separate deployed service later is just an env-var change, no code change.
//
// Uses 127.0.0.1 (not "localhost") deliberately: Node's newer connection
// algorithm can try IPv6 (::1) first when resolving "localhost", and on some
// Windows setups (installing Docker Desktop is a common trigger, since it
// adds its own virtual network adapters) that resolution stops lining up
// with what the server actually listens on -- causing this exact process's
// own loopback calls to itself to fail with ECONNREFUSED even though the
// server is clearly running. Using the literal IPv4 address sidesteps the
// DNS resolution step entirely.
const GRAPHQL_ENDPOINTS = {
  farmerData: process.env.DEMOGRAPHIC_GRAPHQL_URL || 'http://127.0.0.1:4000/graphql/demographic',
  landData: process.env.LAND_GRAPHQL_URL || 'http://127.0.0.1:4000/graphql/land',
  landOwnershipData: process.env.LAND_OWNERSHIP_GRAPHQL_URL || 'http://127.0.0.1:4000/graphql/land-ownership',
};

async function callGraphQL(profileKey, query, variables) {
  const url = GRAPHQL_ENDPOINTS[profileKey];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL error from ${profileKey}: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

module.exports = { callGraphQL, GRAPHQL_ENDPOINTS };
