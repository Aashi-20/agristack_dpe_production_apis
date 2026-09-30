// Format-only checks on two header fields shared by every seek variant
// (sync, both doors, and async). Deliberately format only, not uniqueness --
// message_id isn't checked against anything previously seen, unlike
// transaction_id, which has its own real duplicate-rejection logic
// elsewhere (transactionDedup.js).

// Standard UUID shape (8-4-4-4-12 hex, case-insensitive) -- matches any
// UUID version, since only the shape is being checked here, not which
// version generated it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ISO 8601 date-time with an explicit timezone marker -- either "Z" (UTC)
// or a numeric offset like "+05:30" or "-08:00". This is the exact shape
// used throughout every real request in this project (e.g.
// "2026-09-29T10:00:00+05:30"). An offset-less local time like
// "2026-09-29T10:00:00" is deliberately rejected, since without a zone
// it's genuinely ambiguous what instant it refers to.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Returns { code, message } if the header fails either check, or null if
// both are fine. Callers pass this straight into sendError() on failure.
function validateRequestHeader(header) {
  const messageId = header?.message_id;
  if (!messageId || !UUID_RE.test(messageId)) {
    return {
      code: 'INVALID_MESSAGE_ID',
      message: `header.message_id must be a valid UUID (e.g. 9d10494b-a217-4c7a-89e8-410d6f135fc9) -- got '${messageId}'.`,
    };
  }

  const messageTs = header?.message_ts;
  // Date.parse() as a second check, not just the regex -- catches a
  // value that's the right SHAPE but not a real date, e.g. a February 30th.
  if (!messageTs || !TIMESTAMP_RE.test(messageTs) || Number.isNaN(Date.parse(messageTs))) {
    return {
      code: 'INVALID_MESSAGE_TS',
      message: `header.message_ts must be an ISO 8601 date-time with a timezone offset (e.g. 2026-09-29T10:00:00+05:30) -- got '${messageTs}'.`,
    };
  }

  return null;
}

module.exports = { validateRequestHeader };
