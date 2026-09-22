const fetch = require('node-fetch');
const { fetchServiceToken } = require('./tokenClient');

// Asks the Network Manager whether an AIU's bearer token is valid for the
// entity_id it claims. entity_id is the sender_id from the seek request's
// own header -- i.e. "prove this token belongs to the sender you say it does."
async function introspectToken(incomingToken, entityId) {
  if (!process.env.NM_INTROSPECT_URL) {
    throw new Error('NM_INTROSPECT_URL must be set in .env to verify tokens against the Network Manager.');
  }

  const serviceToken = await fetchServiceToken();

  const res = await fetch(process.env.NM_INTROSPECT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceToken}`,
    },
    body: JSON.stringify({ token: incomingToken, entity_id: entityId }),
  });
  return res.json();
}

module.exports = { introspectToken };
