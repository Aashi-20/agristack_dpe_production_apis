const { sendError } = require('../utils/apiError');

// The three /graphql/* endpoints have no authentication of their own: they
// return every column of the underlying table, and it's the orchestrator
// (resolveSeekResponse.js) that decides which fields an AIU may see, after
// its own auth, authorization, encryption and audit steps. The orchestrator
// reaches them over 127.0.0.1, i.e. from this same process.
//
// Because they share the app's public port, anything that can reach that
// port could otherwise query them directly and skip all of those steps.
// This guard only lets loopback callers through. It looks at the actual
// TCP peer address, not headers such as X-Forwarded-For, so a caller can't
// talk their way past it.
//
// GRAPHQL_LOCAL_ONLY=false turns it off -- only needed if you deliberately
// split a profile into its own separate service (see graphqlExecutor.js),
// and then that service should be protected some other way.
function isLoopback(address) {
  if (!address) return false;
  return address === '::1' || /^(::ffff:)?127\./.test(address);
}

function localOnly(req, res, next) {
  if (process.env.GRAPHQL_LOCAL_ONLY === 'false') return next();

  const peer = req.socket && req.socket.remoteAddress;
  if (isLoopback(peer)) return next();

  console.warn(`[graphql] Blocked non-local request to ${req.originalUrl} from ${peer}`);
  return sendError(res, 403, 'INTERNAL_ONLY', 'This endpoint is internal and not available externally');
}

module.exports = { localOnly, isLoopback };
