const { createKafkaClient } = require('../kafka/client');
const { SEEK_PROCESSED_TOPIC } = require('../kafka/topics');
const { ensureTopicsExist } = require('../kafka/ensureTopics');

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

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

// Publishes the seek-processed event with a small bounded retry. This NEVER
// throws -- callers (resolveAndPublish.js) call this after the AIU's
// response has already been sent, so there is no one left to hand an error
// back to. If every attempt fails, this is exactly the "dual-write risk"
// the design doc calls out: the response went out, but the audit/telemetry
// trail for it didn't. Logged loudly here as a stand-in for real
// operational alerting (paging, a dead-letter topic, etc.) in production.
async function publishSeekProcessedEvent(event) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const producer = await getProducer();
      await producer.send({
        topic: SEEK_PROCESSED_TOPIC,
        messages: [{ key: event.requestId, value: JSON.stringify(event) }],
      });
      console.log(`[telemetry] Published to Kafka topic "${SEEK_PROCESSED_TOPIC}": requestId=${event.requestId}`);
      return;
    } catch (err) {
      console.error(`[telemetry] Publish attempt ${attempt}/${MAX_ATTEMPTS} failed for requestId ${event.requestId}: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      console.error(
        `[telemetry] ALERT: giving up publishing seek-processed for requestId ${event.requestId} after ${MAX_ATTEMPTS} attempts:`,
        err.message
      );
    }
  }
}

module.exports = { publishSeekProcessedEvent };
