const dotenvResult = require('dotenv').config();
if (dotenvResult.error) {
  console.warn(`[dotenv] Could not load .env: ${dotenvResult.error.message}`);
} else {
  console.log(`[dotenv] Loaded .env -- keys found: ${Object.keys(dotenvResult.parsed || {}).join(', ') || '(none)'}`);
}

const { startTelemetryConsumer } = require('./consumer');

startTelemetryConsumer().catch((err) => {
  console.error('[telemetry] Crashed:', err);
  process.exit(1);
});
