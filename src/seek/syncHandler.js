const { resolveAndPublishSeek } = require('../telemetry/resolveAndPublish');
const { isDuplicateTransaction } = require('../orchestrator/transactionDedup');
const { getAiuPublicKey } = require('../encryption/keyRegistry');
const { encryptForAiu } = require('../encryption/envelopeEncrypt');
const { sendError } = require('../utils/apiError');

// Envelope-encrypts message.seek_response (the actual farmer data) in
// place, if USE_RESPONSE_ENCRYPTION=true. Header/status metadata stays
// plaintext -- only the sensitive payload is protected. Deliberately FAILS
// (rather than silently falling back to plaintext) if the requesting AIU
// has no registered public key -- sending plaintext by accident would
// defeat the entire point of this feature.
async function maybeEncryptResponse(body, senderId) {
  if (process.env.USE_RESPONSE_ENCRYPTION !== 'true') {
    return body;
  }

  console.log(`[encryption] Beginning response encryption for sender_id=${senderId}.`);
  console.log(`[encryption] Looking up registered public key for sender_id=${senderId}...`);
  const publicKey = await getAiuPublicKey(senderId);
  if (!publicKey) {
    throw new Error(`No public key registered for sender_id=${senderId} -- cannot encrypt response. Register one in aiu_public_key before enabling USE_RESPONSE_ENCRYPTION for this AIU.`);
  }
  console.log('[encryption] Public key found. Handing off to envelopeEncrypt...');

  const envelope = encryptForAiu(body.message.seek_response, publicKey);
  console.log(`[encryption] Done -- response payload replaced with encrypted envelope (${envelope.algorithm}).`);

  delete body.message.seek_response;
  body.message.encrypted_data = envelope.encryptedData;
  body.message.encrypted_key = envelope.encryptedKey;
  body.message.iv = envelope.iv;
  body.message.auth_tag = envelope.authTag;
  body.message.encryption_alg = envelope.algorithm;

  return body;
}

// v2: synchronous. Resolve the request and send the full on-seek response
// back as the HTTP response itself -- no acknowledgment, no callback.
async function handleSyncSeek(req, res) {
  const { header, message } = req.body;
  const transactionId = message?.transaction_id;
  console.log(`[seek][SYNC] Received request: transaction_id=${transactionId}, service_id=${message?.seek_request?.service_id}`);

  if (!transactionId) {
    return sendError(res, 400, 'MISSING_TRANSACTION_ID', 'message.transaction_id is required');
  }

  if (await isDuplicateTransaction(transactionId)) {
    console.log(`[seek][SYNC] Rejected: duplicate transaction_id=${transactionId}`);
    return sendError(res, 409, 'DUPLICATE_TRANSACTION_ID', `transaction_id '${transactionId}' has already been used. transaction_id must be unique per request.`);
  }

  try {
    const { httpStatus, body } = await resolveAndPublishSeek(req.body, 'SYNC', req.originalUrl);

    if (httpStatus === 200) {
      await maybeEncryptResponse(body, header.sender_id);
    }

    console.log(`[seek][SYNC] Completed: transaction_id=${transactionId}, httpStatus=${httpStatus}`);
    return res.status(httpStatus).json(body);
  } catch (err) {
    console.error(`[seek][SYNC] Error: transaction_id=${transactionId}:`, err.message);
    return sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
}

module.exports = { handleSyncSeek };
