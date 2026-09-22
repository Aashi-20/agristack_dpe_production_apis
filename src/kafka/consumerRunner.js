const dotenvResult = require('dotenv').config();
if (dotenvResult.error) {
  console.warn(`[dotenv] Could not load .env: ${dotenvResult.error.message}`);
  console.warn(`[dotenv] Working directory: ${process.cwd()} -- make sure a file literally named ".env" (not ".env.txt") exists here.`);
} else {
  console.log(`[dotenv] Loaded .env from ${process.cwd()} -- keys found: ${Object.keys(dotenvResult.parsed || {}).join(', ') || '(none)'}`);
}

const { startConsumer } = require('./consumer');

startConsumer().catch((err) => {
  console.error('[consumer] Crashed:', err);
  process.exit(1);
});
