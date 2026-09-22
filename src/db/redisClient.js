const { createClient } = require('redis');

// One shared Redis connection, lazily created on first use and reused for
// every cache in this app. Redis is a separate process from Node itself --
// unlike a plain in-memory Map(), its data survives an API restart and is
// shared across every running instance of this app (critical the moment
// this is ever scaled to more than one instance, which in-memory caches
// fundamentally can't do).
let clientPromise = null;

async function getRedisClient() {
  if (!clientPromise) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const client = createClient({ url });
    client.on('error', (err) => console.error('[redis] Client error:', err.message));
    clientPromise = client.connect().then(() => {
      console.log(`[redis] Connected to ${url}`);
      return client;
    });
  }
  return clientPromise;
}

module.exports = { getRedisClient };
