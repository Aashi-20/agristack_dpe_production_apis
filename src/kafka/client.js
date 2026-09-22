const { Kafka } = require('kafkajs');

// Silences KafkaJS's "switched default partitioner" warning. It's purely
// informational (about which partition a message lands in) and irrelevant
// here since agristack.seek.requests has only 1 partition -- everything
// goes there regardless of which partitioner strategy is used.
if (!process.env.KAFKAJS_NO_PARTITIONER_WARNING) {
  process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
}

// One shared way to build a Kafka client, used by both the producer (in the
// API process) and the consumer (its own separate process).
function createKafkaClient() {
  return new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'agristack-dpe',
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  });
}

module.exports = { createKafkaClient };
