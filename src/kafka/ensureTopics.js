const { createKafkaClient } = require('./client');
const { SEEK_REQUEST_TOPIC, SEEK_PROCESSED_TOPIC } = require('./topics');

// Explicitly creates topics if they don't exist yet, rather than relying on
// the broker's auto.create.topics.enable setting -- see the long comment
// history around this file for why (a fresh topic's first metadata request
// can come back as UNKNOWN_TOPIC_OR_PARTITION while creation is still in
// flight, even when auto-create is technically on).
async function ensureTopicsExist(topicNames = [SEEK_REQUEST_TOPIC, SEEK_PROCESSED_TOPIC]) {
  const kafka = createKafkaClient();
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = await admin.listTopics();
    const missing = topicNames.filter((t) => !existing.includes(t));
    if (missing.length) {
      await admin.createTopics({
        topics: missing.map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })),
        waitForLeaders: true,
      });
      console.log(`[kafka] Created topic(s): ${missing.join(', ')}`);
    }
  } finally {
    await admin.disconnect();
  }
}

module.exports = { ensureTopicsExist };
