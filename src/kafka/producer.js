const { createKafkaClient } = require('./client');
const { SEEK_REQUEST_TOPIC } = require('./topics');
const { ensureTopicsExist } = require('./ensureTopics');

// One producer connection, reused across requests (connecting per-request
// would be slow and eventually exhaust connections).
let producerPromise = null;

async function getProducer() {
  if (!producerPromise) {
    producerPromise = (async () => {
      await ensureTopicsExist();
      const kafka = createKafkaClient();
      const producer = kafka.producer();
      await producer.connect();
      return producer;
    })();
  }
  return producerPromise;
}

// Publishes the raw seek request (header + message, exactly what the API
// received) onto the topic. The consumer -- a separate process -- does the
// actual GraphQL work and callback delivery. This function resolving means
// Kafka has durably accepted the message; the caller should only ACK the
// AIU after this succeeds, not before.
async function publishSeekRequest(requestBody) {
  const producer = await getProducer();
  const key = requestBody?.message?.transaction_id || requestBody?.header?.sender_id || undefined;
  await producer.send({
    topic: SEEK_REQUEST_TOPIC,
    messages: [{ key, value: JSON.stringify(requestBody) }],
  });
}

module.exports = { publishSeekRequest };
