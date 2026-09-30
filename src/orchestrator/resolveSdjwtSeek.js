const fetch = require('node-fetch');
const { isSenderMappedToService } = require('../config/senderServiceMap');
const { encryptForAiu } = require('../encryption/envelopeEncrypt');
const { errorBody } = require('../utils/apiError');

// Alternate sync-only flow for services flagged in aiu_sdjwt_config
// (checked by the caller -- see resolveAndPublish.js). Instead of the
// normal GraphQL-backed profile lookup, this calls a separate external
// service that issues a signed SD-JWT verifiable credential for one
// farmer, then envelope-encrypts that credential using the RSA public key
// supplied IN THE REQUEST ITSELF (query_param.responseEncryption.publicKey)
// -- not the AIU's key from aiu_public_key. That's a deliberate difference
// from the normal encryption path: this flow's whole point is delivering a
// credential encrypted for a key the caller names per-request, so it
// always encrypts, unconditionally -- USE_RESPONSE_ENCRYPTION and the
// gateway's forced-encryption flag are both irrelevant here, and
// syncHandler.js's maybeEncryptResponse() skips a response that already
// carries encrypted_data, which this flow always produces on success.
//
// Expected query_param shape:
//   {
//     "credentialType": "FarmerRegistryCredential",
//     "format": "sd-jwt",
//     "farmerId": "<fr_central_id>",
//     "responseEncryption": { "alg": "RSA-OAEP-256", "publicKey": "<PEM or bare base64>" }
//   }
async function resolveSdjwtSeek(requestBody) {
  const { header, message } = requestBody;
  const senderId = header.sender_id;
  const serviceId = message?.seek_request?.service_id;
  const qp = message?.seek_request?.query_param || {};

  function fail(httpStatus, code, msg) {
    return {
      httpStatus,
      body: {
        header: { ...header, action: 'on-seek', status: 'failed', status_reason_code: code },
        message: { transaction_id: message.transaction_id },
        error: errorBody(code, msg),
      },
    };
  }

  // Authorization is normally the first thing resolveSeekResponse.js does.
  // This flow bypasses that function entirely, so it has to repeat the
  // same check itself -- otherwise flagging a service_id for SD-JWT mode
  // would silently disable the sender/service authorization check for it.
  const authorized = await isSenderMappedToService(senderId, serviceId);
  if (!authorized) {
    console.log(`[sdjwt] Rejected: sender_id=${senderId} is not authorized for service_id=${serviceId}.`);
    return fail(403, 'SENDER_NOT_MAPPED_TO_SERVICE', `sender_id '${senderId}' is not authorized to use service_id '${serviceId}'.`);
  }

  const farmerId = qp.farmerId;
  const publicKey = qp.responseEncryption?.publicKey;
  const alg = qp.responseEncryption?.alg;

  if (!farmerId) {
    return fail(400, 'MISSING_FARMER_ID', 'query_param.farmerId is required for this service.');
  }
  if (!publicKey) {
    return fail(400, 'MISSING_PUBLIC_KEY', 'query_param.responseEncryption.publicKey is required for this service.');
  }
  if (alg && alg !== 'RSA-OAEP-256') {
    return fail(400, 'UNSUPPORTED_ALG', `Unsupported responseEncryption.alg '${alg}' -- only RSA-OAEP-256 is supported.`);
  }
  if (!process.env.SDJWT_SHARE_API_URL) {
    return fail(502, 'SDJWT_SERVICE_UNAVAILABLE', 'SDJWT_SHARE_API_URL is not configured.');
  }

  console.log(`[sdjwt] Step 1/4: Requesting a credential for farmerId=${farmerId} from ${process.env.SDJWT_SHARE_API_URL}...`);
  let sdJwt;
  try {
    const res = await fetch(process.env.SDJWT_SHARE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frCentralId: farmerId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`responded ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    sdJwt = json.sdJwt;
    if (!sdJwt) throw new Error('response had no "sdJwt" field');
  } catch (err) {
    console.error(`[sdjwt] Step 1/4 FAILED: ${err.message}`);
    return fail(502, 'SDJWT_SERVICE_UNAVAILABLE', `Could not retrieve the credential: ${err.message}`);
  }
  console.log(`[sdjwt] Step 1/4 done: credential retrieved (${sdJwt.length} chars).`);

  console.log('[sdjwt] Step 2/4: Encrypting the credential with the caller-supplied public key (RSA-OAEP-256)...');
  const credentialType = qp.credentialType || 'FarmerRegistryCredential';
  const format = qp.format || 'sd-jwt';
  let envelope;
  try {
    envelope = encryptForAiu({ credentialType, format, sdJwt }, publicKey);
  } catch (err) {
    console.error(`[sdjwt] Step 2/4 FAILED: ${err.message}`);
    return fail(400, 'INVALID_PUBLIC_KEY', `Could not use the supplied responseEncryption.publicKey: ${err.message}`);
  }
  console.log('[sdjwt] Step 2/4 done.');

  console.log('[sdjwt] Step 3/4: Building the on-seek response...');
  const body = {
    // is_msg_encrypted: true, always -- this flow's whole point is
    // delivering an encrypted credential, unconditionally.
    header: { ...header, action: 'on-seek', status: 'succeed', status_reason_code: 'NA', is_msg_encrypted: true },
    message: {
      transaction_id: message.transaction_id,
      encrypted_data: envelope.encryptedData,
      encrypted_key: envelope.encryptedKey,
      iv: envelope.iv,
      auth_tag: envelope.authTag,
      encryption_alg: envelope.algorithm,
    },
  };
  console.log('[sdjwt] Step 4/4: Done.');

  return {
    httpStatus: 200,
    body,
    // Consumed by eventBuilder.js in place of the values it would normally
    // derive from body.message.seek_response, which doesn't exist here --
    // without this, the audit trail would show zero farmers/records shared
    // even though a real credential, containing real farmer PII, was sent.
    auditMeta: {
      farmerIds: [farmerId],
      sharedData: ['sdJwt'],
      recordCount: 1,
      farmerPayloads: [{ frCentralId: farmerId, payload: { credentialType, format, sdJwt } }],
    },
  };
}

module.exports = { resolveSdjwtSeek };
