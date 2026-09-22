const dotenvResult = require('dotenv').config();
if (dotenvResult.error) {
  console.warn(`[dotenv] Could not load .env: ${dotenvResult.error.message}`);
  console.warn(`[dotenv] Working directory: ${process.cwd()} -- make sure a file literally named ".env" (not ".env.txt") exists here.`);
} else {
  console.log(`[dotenv] Loaded .env from ${process.cwd()} -- keys found: ${Object.keys(dotenvResult.parsed || {}).join(', ') || '(none)'}`);
}

// DEV ONLY: some corporate networks/proxies intercept HTTPS with a
// certificate Node doesn't trust, causing outbound calls (like the async
// seek callback to sender_uri) to fail with "unable to get local issuer
// certificate". Setting this env var disables TLS certificate verification
// entirely -- convenient for local testing against things like webhook.site,
// but NEVER set this in a real/production environment.
if (process.env.DEV_DISABLE_TLS_VERIFY === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[dev] TLS certificate verification is DISABLED (DEV_DISABLE_TLS_VERIFY=true). This is insecure -- do not use outside local dev.');
}

const express = require('express');
const bodyParser = require('body-parser');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');

const demographicTypeDefs = require('./graphql/demographic/typeDefs');
const demographicResolvers = require('./graphql/demographic/resolvers');
const landTypeDefs = require('./graphql/land/typeDefs');
const landResolvers = require('./graphql/land/resolvers');
const landOwnershipTypeDefs = require('./graphql/landOwnership/typeDefs');
const landOwnershipResolvers = require('./graphql/landOwnership/resolvers');

const { verifyToken } = require('./auth/verifyTokenMiddleware');
const { handleSyncSeek } = require('./seek/syncHandler');
const { handleAsyncSeek } = require('./seek/asyncHandler');
const { sendError } = require('./utils/apiError');

const SEEK_BASE = '/dpe';

async function startServer() {
  const app = express();
  app.use(bodyParser.json());

  // Three independent GraphQL APIs, one per canonical data profile.
  const demographicServer = new ApolloServer({ typeDefs: demographicTypeDefs, resolvers: demographicResolvers });
  const landServer = new ApolloServer({ typeDefs: landTypeDefs, resolvers: landResolvers });
  const landOwnershipServer = new ApolloServer({ typeDefs: landOwnershipTypeDefs, resolvers: landOwnershipResolvers });

  await Promise.all([demographicServer.start(), landServer.start(), landOwnershipServer.start()]);

  app.use('/graphql/demographic', expressMiddleware(demographicServer));
  app.use('/graphql/land', expressMiddleware(landServer));
  app.use('/graphql/land-ownership', expressMiddleware(landOwnershipServer));

  // Real, authenticated Data Sharing API. Shortened from the original
  // /agristack-data-provisioning-engine/v{n}/api/assetIdentification/seek
  // to /dpe/v{n}/seek -- same auth, same behavior, just a shorter path.
  // verifyToken runs first on both versions.
  app.post(`${SEEK_BASE}/v1/seek`, verifyToken, handleAsyncSeek);  // async
  app.post(`${SEEK_BASE}/v2/seek`, verifyToken, handleSyncSeek);   // sync

  // Catch-all 404, in the same standard error envelope as every other
  // response -- without this, an unmatched route falls through to
  // Express's default HTML error page, breaking the "every response uses
  // {error:{code,message}}" contract for this one case.
  app.use((req, res) => {
    sendError(res, 404, 'NOT_FOUND', `No route matches ${req.method} ${req.originalUrl}`);
  });

  const PORT = process.env.PORT || 4000;
  // Explicit '0.0.0.0' (IPv4) bind, to match the 127.0.0.1 the orchestrator
  // uses to call these same GraphQL endpoints internally -- see the comment
  // in graphqlExecutor.js for why "localhost" alone can be unreliable here.
  app.listen(PORT, '0.0.0.0', () => {
    const kafkaMode = process.env.USE_KAFKA === 'true'
      ? 'ON (v1 seek publishes to Kafka -- npm run consumer must be running separately)'
      : 'OFF (v1 seek does the work in-process, no Kafka involved)';
    const telemetryMode = process.env.USE_TELEMETRY_EVENTS === 'true'
      ? 'ON (seek-processed events published -- npm run telemetry-consumer must be running separately)'
      : 'OFF (no audit/telemetry events published)';

    console.log(`Data Sharing API running on http://localhost:${PORT}`);
    console.log(`  ClickHouse:    ${process.env.CLICKHOUSE_HOST || '(NOT SET -- required)'}`);
    console.log(`  NM introspect: ${process.env.NM_INTROSPECT_URL || '(NOT SET -- seek requests will fail auth)'}`);
    console.log(`  Kafka mode:     ${kafkaMode}`);
    console.log(`  Telemetry mode: ${telemetryMode}`);

    const missing = ['CLICKHOUSE_HOST', 'NM_TOKEN_URL', 'NM_INTROSPECT_URL', 'NM_USERNAME', 'NM_PASSWORD']
      .filter((key) => !process.env[key]);
    if (missing.length) {
      console.warn(`  [config] Missing from .env: ${missing.join(', ')} -- requests needing these will fail with a clear error until set.`);
    }

    console.log(`  Demographic GraphQL:    http://localhost:${PORT}/graphql/demographic`);
    console.log(`  Land GraphQL:           http://localhost:${PORT}/graphql/land`);
    console.log(`  Land Ownership GraphQL: http://localhost:${PORT}/graphql/land-ownership`);
    console.log(`  Seek v1 (async, auth):  POST http://localhost:${PORT}${SEEK_BASE}/v1/seek`);
    console.log(`  Seek v2 (sync, auth):   POST http://localhost:${PORT}${SEEK_BASE}/v2/seek`);
  });
}

startServer();
