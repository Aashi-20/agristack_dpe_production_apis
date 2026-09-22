module.exports = {
  SEEK_REQUEST_TOPIC: process.env.KAFKA_SEEK_REQUEST_TOPIC || 'agristack.seek.requests',
  // Canonical audit/telemetry/transparency event, published by BOTH the sync
  // and async seek paths after they reach a final SUCCESS or FAILED outcome.
  // Separate from SEEK_REQUEST_TOPIC, which only carries the original async
  // request so the async consumer can do the actual GraphQL work.
  SEEK_PROCESSED_TOPIC: process.env.KAFKA_SEEK_PROCESSED_TOPIC || 'agristack.seek.processed',
};
