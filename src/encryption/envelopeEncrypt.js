const crypto = require('crypto');

// The correct, minimal way to send a public key here is: the PEM content
// lines only (no BEGIN/END markers), joined into ONE unbroken base64
// string (the internal newlines in a .pem file only exist for that
// format's 64-char line wrapping -- they carry no meaning and don't need
// to be reproduced). That single string, base64-decoded exactly once,
// yields the raw DER bytes.
//
// In practice callers also send it a few other ways, so this accepts all
// of them by trying to unwrap up to two extra encoding layers, checking
// after each one whether what's left is real PEM text or plausible base64
// text (as opposed to binary DER, which is where genuine content lives and
// where unwrapping must stop):
//   1. Already a full PEM, with BEGIN/END markers -- used as-is.
//   2. The correct minimal form above -- one clean base64 string, decodes
//      directly to binary DER. No layers to unwrap; markers just get added.
//   3. Base64 of the ENTIRE PEM text, markers included -- decoding once
//      reveals real PEM text (contains "BEGIN PUBLIC KEY").
//   4. Base64 of the content lines WITH their internal newlines, encoded a
//      second time by mistake -- decoding once reveals text that is itself
//      still base64 (not binary), so it gets decoded again before use.
// Whichever of these produced the ASN.1 "wrong tag" error before, all four
// now resolve to the same valid key.
function looksLikeBase64Text(s) {
  return /^[A-Za-z0-9+/=\s]+$/.test(s) && s.replace(/\s+/g, '').length > 20;
}

function toPemPublicKey(raw) {
  let current = raw.trim();

  for (let layer = 0; layer < 2; layer++) {
    if (current.includes('BEGIN PUBLIC KEY')) return current; // case 1 or 3, mid-unwrap

    let decodedText;
    try {
      decodedText = Buffer.from(current, 'base64').toString('utf8');
    } catch {
      break; // not valid base64 at all -- stop unwrapping
    }

    if (decodedText.includes('BEGIN PUBLIC KEY')) return decodedText; // case 3

    if (looksLikeBase64Text(decodedText) && decodedText.trim() !== current) {
      current = decodedText.trim(); // case 4: one more encoding layer to peel off
      continue;
    }
    break; // decoded to binary DER (or garbage) -- this is the real content, stop
  }

  if (current.includes('BEGIN PUBLIC KEY')) return current;

  const cleaned = current.replace(/\s+/g, '');
  const lines = cleaned.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`; // case 2
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
