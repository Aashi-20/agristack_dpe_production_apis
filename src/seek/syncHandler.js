const { resolveAndPublishSeek } = require('../telemetry/resolveAndPublish');
const { isDuplicateTransaction } = require('../orchestrator/transactionDedup');
const { getAiuPublicKey } = require('../encryption/keyRegistry');
const { encryptForAiu } = require('../encryption/envelopeEncrypt');
const { sendError } = require('../utils/apiError');
const { validateRequestHeader } = require('../utils/validateRequestHeader');

// Envelope-encrypts message.seek_response (the actual farmer data) in
// place, if USE_RESPONSE_ENCRYPTION=true. Header/status metadata stays
// plaintext -- only the sensitive payload is protected. Deliberately FAILS
// (rather than silently falling back to plaintext) if the requesting AIU
// has no registered public key -- sending plaintext by accident would
// defeat the entire point of this feature.
//
// force=true (the gateway door) encrypts regardless of USE_RESPONSE_ENCRYPTION:
// a response that passes through the central layer must never carry
// plaintext farmer data, so that door doesn't get an off switch.
async function maybeEncryptResponse(body, senderId, { force = false } = {}) {
  // A response can already be fully encrypted before this runs -- the
  // SD-JWT flow (resolveSdjwtSeek.js) always encrypts, unconditionally,
  // using a public key supplied IN THE REQUEST rather than the AIU's
  // registered key. Re-encrypting it here (or worse, encrypting the
  // now-absent seek_response and silently dropping the real payload)
  // would be wrong, so any response that already carries encrypted_data
  // is left untouched.
  if (body.message.encrypted_data) {
    return body;
  }
  if (!force && process.env.USE_RESPONSE_ENCRYPTION !== 'true') {
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

  // The response header carries whatever is_msg_encrypted value the AIU
  // sent in their REQUEST (normally false, since the request itself isn't
  // encrypted) -- it's never automatically correct for the outgoing
  // response until set here, now that we actually know encryption happened.
  body.header.is_msg_encrypted = true;

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
//
// One implementation, two doors (see index.js):
//   - direct:  /dpe/v2/seek           -- encryption follows USE_RESPONSE_ENCRYPTION
//   - gateway: /dpe/internal/v2/seek  -- encryption always on
function buildSyncHandler({ forceEncryption = false } = {}) {
  const tag = forceEncryption ? '[seek][SYNC][gateway]' : '[seek][SYNC]';

  return async function handleSync(req, res) {
    const { header, message } = req.body;
    const transactionId = message?.transaction_id;
    console.log(`${tag} Received request: transaction_id=${transactionId}, service_id=${message?.seek_request?.service_id}`);

    const headerError = validateRequestHeader(header);
    if (headerError) {
      return sendError(res, 400, headerError.code, headerError.message);
    }

    if (!transactionId) {
      return sendError(res, 400, 'MISSING_TRANSACTION_ID', 'message.transaction_id is required');
    }

    if (await isDuplicateTransaction(transactionId)) {
      console.log(`${tag} Rejected: duplicate transaction_id=${transactionId}`);
      return sendError(res, 409, 'DUPLICATE_TRANSACTION_ID', `transaction_id '${transactionId}' has already been used. transaction_id must be unique per request.`);
    }

    try {
      const { httpStatus, body } = await resolveAndPublishSeek(req.body, 'SYNC', req.originalUrl);

      if (httpStatus === 200) {
        await maybeEncryptResponse(body, header.sender_id, { force: forceEncryption });
      }

      console.log(`${tag} Completed: transaction_id=${transactionId}, httpStatus=${httpStatus}`);
      return res.status(httpStatus).json(body);
    } catch (err) {
      console.error(`${tag} Error: transaction_id=${transactionId}:`, err.message);
      return sendError(res, 500, 'INTERNAL_ERROR', err.message);
    }
  };
}

const handleSyncSeek = buildSyncHandler();
const handleGatewaySyncSeek = buildSyncHandler({ forceEncryption: true });

module.exports = { handleSyncSeek, handleGatewaySyncSeek };
