const { getRedisClient } = require('../db/redisClient');
const { DATA_SHARING_DB } = require('../db/dataSharingDb');
const clickhouse = require('../db/clickhouse');

// Enforces that each seek request's message.transaction_id is unique.
//
// REDIS is the real gatekeeper: key "dpe:seek:transaction:<transaction_id>",
// set via SET ... NX EX in ONE atomic Redis command -- "set this only if it
// doesn't already exist, and auto-expire it after TRANSACTION_DEDUP_TTL_MS
// (default 24h)." Because this is a single atomic operation (not a
// separate check-then-insert), two requests with the identical
// transaction_id arriving at the exact same instant can never both pass --
// whichever's SET actually lands first "wins" the key, and the other's SET
// fails immediately, deterministically. This is the same idempotency-key
// pattern used by payment processors like Stripe.
//
// The 24h TTL is a deliberate choice: duplicate-submission protection only
// needs to matter for a reasonable replay window, not forever. Permanent
// history doesn't disappear, though -- see below.
//
// CLICKHOUSE is kept as a permanent, fire-and-forget AUDIT record, not part
// of the accept/reject decision at all anymore. It never blocks the
// request and never affects the outcome; it's purely so a transaction_id's
// history survives past Redis's 24h TTL, for compliance/forensics. If this
// write fails for some reason, the request still succeeds -- only the
// long-term audit trail is at (non-fatal) risk, not the actual dedup
// guarantee, which Redis already enforced synchronously above.
const TABLE_SUFFIX = process.env.TELEMETRY_TABLE_SUFFIX ?? '_dist';
const TABLE = `${DATA_SHARING_DB}.seek_transaction_dedup${TABLE_SUFFIX}`;
const TTL_SECONDS = Math.ceil(Number(process.env.TRANSACTION_DEDUP_TTL_MS || 48 * 60 * 60 * 1000) / 1000);

function keyFor(transactionId) {
  return `dpe:seek:transaction:${transactionId}`;
}

// Returns true if this transaction_id was ALREADY used (reject it) --
// false if it's new (and it's now recorded, atomically, as part of this
// same call -- there's no separate "record" step to forget to call).
async function isDuplicateTransaction(transactionId) {
  const redis = await getRedisClient();
  const result = await redis.set(keyFor(transactionId), '1', { NX: true, EX: TTL_SECONDS });
  const isNew = result !== null; // node-redis returns null when NX prevented the SET

  if (isNew) {
    console.log(`[redis] Recorded new transaction_id=${transactionId} (NX, TTL ${TTL_SECONDS}s)`);
    clickhouse.insert({
      table: TABLE,
      values: [{ transaction_id: transactionId }],
      format: 'JSONEachRow',
    }).catch((err) => {
      console.error(`[dedup] Failed to write permanent audit record for transaction_id=${transactionId} (non-fatal):`, err.message);
    });
  } else {
    console.log(`[redis] transaction_id=${transactionId} already exists -- rejecting as duplicate.`);
  }

  return !isNew;
}

module.exports = { isDuplicateTransaction };
