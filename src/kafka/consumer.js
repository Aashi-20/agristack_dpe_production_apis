const fetch = require('node-fetch');
const { createKafkaClient } = require('./client');
const { SEEK_REQUEST_TOPIC } = require('./topics');
const { ensureTopicsExist } = require('./ensureTopics');
const { resolveAndPublishSeek } = require('../telemetry/resolveAndPublish');

// Standalone worker loop: reads seek requests off Kafka, does the real
// GraphQL resolution (via the exact same resolveSeekResponse used by the
// synchronous route -- no duplicated logic), and POSTs the finished on-seek
// response to the sender_uri from the original request.
//
// Run this as its own OS process (`npm run consumer`), separate from the API
// server. That separation is the whole point: the API server can restart or
// scale independently, and a message that's on Kafka survives a consumer
// crash -- eachMessage only "completes" (advances the committed offset)
// after the try block below finishes without throwing.
async function startConsumer() {
  await ensureTopicsExist();

  const kafka = createKafkaClient();
  const consumer = kafka.consumer({
    groupId: process.env.KAFKA_CONSUMER_GROUP_ID || 'agristack-seek-consumer',
  });

  await consumer.connect();
  await consumer.subscribe({ topic: SEEK_REQUEST_TOPIC, fromBeginning: false });

  console.log(`[consumer] Listening on topic "${SEEK_REQUEST_TOPIC}"...`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      let requestBody;
      try {
        requestBody = JSON.parse(message.value.toString());
      } catch (err) {
        console.error('[consumer] Skipping unparseable message:', err.message);
        return; // not retryable -- bad data, move on
      }

      const transactionId = requestBody?.message?.transaction_id;
      const senderUri = requestBody?.header?.sender_uri;

      try {
        console.log(`[consumer] Preparing data for transaction ${transactionId}...`);
        // Hardcoded: this consumer only ever processes messages published by
        // the v1 async route (kafka/producer.js is only ever called from
        // asyncHandler.js's Kafka branch), so there's exactly one possible
        // originating endpoint here -- unlike the sync/legacy paths, there's
        // no live req object in this separate process to read it from.
        const { body } = await resolveAndPublishSeek(requestBody, 'ASYNC', '/dpe/v1/seek');

        if (!senderUri) {
          console.error(`[consumer] No sender_uri for transaction ${transactionId} -- cannot deliver on-seek.`);
          return;
        }

        await fetch(senderUri, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        console.log(`[consumer] on-seek delivered for transaction ${transactionId} -> ${senderUri}`);
      } catch (err) {
        // Kept simple on purpose (per "let's do very simple" earlier) --
        // in a hardened version this is where you'd retry a bounded number
        // of times and then send to a dead-letter topic instead of just
        // logging and moving on.
        console.error(`[consumer] Failed to process transaction ${transactionId}:`, err.message);
      }
    },
  });
}

module.exports = { startConsumer };
