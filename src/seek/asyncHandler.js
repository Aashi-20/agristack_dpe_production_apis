const fetch = require('node-fetch');
const { resolveAndPublishSeek } = require('../telemetry/resolveAndPublish');
const { publishSeekRequest } = require('../kafka/producer');
const { isDuplicateTransaction } = require('../orchestrator/transactionDedup');
const { sendError } = require('../utils/apiError');

// v1: asynchronous.
//
// With USE_KAFKA=true: publish the request onto Kafka and wait for that to
// be durably confirmed BEFORE sending the ACK -- the ACK means "safely
// queued," not just "accepted into memory." A separate consumer process
// (npm run consumer) does the actual GraphQL work and delivers the on-seek
// callback to sender_uri. This handler's job ends the moment publish
// succeeds; it never talks to GraphQL or ClickHouse itself in this mode.
//
// With USE_KAFKA=false (default, no Kafka required): fall back to doing the
// same work in-process after sending the ACK, exactly like before Kafka was
// introduced -- useful for local testing without standing up a broker.
async function handleAsyncSeek(req, res) {
  const { header, message } = req.body;
  const transactionId = message?.transaction_id;

  if (!header?.sender_uri) {
    return sendError(res, 400, 'MISSING_SENDER_URI', 'header.sender_uri is required for the asynchronous (v1) seek API');
  }
  if (!transactionId) {
    return sendError(res, 400, 'MISSING_TRANSACTION_ID', 'message.transaction_id is required');
  }

  // Checked and recorded here, before Kafka is ever touched -- a duplicate
  // must never reach the queue, since by then it's too late to just say no:
  // it would produce a second ACK now and a second round of processing
  // (and a second callback to sender_uri) later.
  if (await isDuplicateTransaction(transactionId)) {
    return sendError(res, 409, 'DUPLICATE_TRANSACTION_ID', `transaction_id '${transactionId}' has already been used. transaction_id must be unique per request.`);
  }

  if (process.env.USE_KAFKA === 'true') {
    try {
      await publishSeekRequest(req.body);
    } catch (err) {
      // Publish failed -- do NOT ack. The caller should retry the seek call.
      return sendError(res, 502, 'QUEUE_UNAVAILABLE', `Failed to queue seek request: ${err.message}`);
    }
    return res.status(200).json({ message: { ack: { status: 'ACK' } } });
  }

  // Dev fallback: send the ack right away, then do the work after the
  // response has already left. The caller only ever sees this ack.
  res.status(200).json({ message: { ack: { status: 'ACK' } } });

  try {
    const { body } = await resolveAndPublishSeek(req.body, 'ASYNC', req.originalUrl);
    await fetch(header.sender_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`Async seek failed for transaction ${transactionId}:`, err.message);
  }
}

module.exports = { handleAsyncSeek };
