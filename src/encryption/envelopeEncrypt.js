const crypto = require('crypto');

// Accepts either a full PEM (with BEGIN/END markers, what's actually stored
// in aiu_public_key) or a bare base64 blob (same convention as
// verifyJwtLocally.js's NM_PUBLIC_KEY handling), and returns proper PEM.
function toPemPublicKey(raw) {
  if (raw.includes('BEGIN PUBLIC KEY')) return raw;
  const cleaned = raw.replace(/\s+/g, '');
  const lines = cleaned.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

// Envelope-encrypts a JS value for one specific AIU's public key:
//   1. Generate a fresh random AES-256 key + IV -- used once, for this
//      response only, then discarded.
//   2. Encrypt the actual data with AES-256-GCM (authenticated -- any
//      tampering with the ciphertext is detected on decrypt, not silently
//      accepted).
//   3. Encrypt (wrap) that AES key with the AIU's RSA public key
//      (RSA-OAEP-SHA256). This is the "envelope key" -- small, since it's
//      only wrapping a 32-byte AES key, not the actual data.
// Anyone without the AIU's matching private key -- including the central
// hub this is ultimately meant to pass through -- can see neither the data
// nor the key that unlocks it.
function encryptForAiu(plaintextObj, publicKeyRaw) {
  const publicKeyPem = toPemPublicKey(publicKeyRaw);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), 'utf8');
  console.log(`[encryption] Step 1/5: Preparing plaintext payload (${plaintext.length} bytes).`);

  console.log('[encryption] Step 2/5: Generating a fresh random AES-256 key (32 bytes) and IV (12 bytes)...');
  const aesKey = crypto.randomBytes(32); // AES-256
  const iv = crypto.randomBytes(12); // standard GCM IV size

  console.log('[encryption] Step 3/5: Encrypting the payload with AES-256-GCM...');
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  console.log(`[encryption] Step 4/5: Encryption complete -- ciphertext ${encrypted.length} bytes, auth tag ${authTag.length} bytes.`);

  console.log('[encryption] Step 5/5: Wrapping the AES key with the AIU\'s RSA public key (RSA-OAEP-SHA256)...');
  const encryptedKey = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  console.log(`[encryption] AES key wrapped -- envelope key is ${encryptedKey.length} bytes. Discarding the raw AES key from memory now.`);

  return {
    encryptedData: encrypted.toString('base64'),
    encryptedKey: encryptedKey.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    algorithm: 'AES-256-GCM+RSA-OAEP-SHA256',
  };
}

module.exports = { encryptForAiu, toPemPublicKey };
