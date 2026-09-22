// One standardized error envelope, used everywhere in this API instead of
// ad-hoc { error: "some string" } shapes scattered across files.
//
// Every error response looks like:
//   { "error": { "code": "SOME_CODE", "message": "human-readable detail" } }
//
// "code" is the machine-readable part an AIU's own code should branch on;
// "message" is for humans debugging, not for programmatic matching (it can
// change wording without breaking anyone's integration; "code" should not
// change once published).
function sendError(res, statusCode, code, message) {
  return res.status(statusCode).json({ error: { code, message } });
}

// Same shape, for the few places (resolveSeekResponse.js) that build a
// response body to return up the call stack rather than calling res
// directly, since that function is shared by three different HTTP layers
// (sync, async, legacy) that each send the response differently.
function errorBody(code, message) {
  return { code, message };
}

module.exports = { sendError, errorBody };
