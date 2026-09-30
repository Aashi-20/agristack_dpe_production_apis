const { v4: uuidv4 } = require('uuid');
const { resolveSeekResponse } = require('../orchestrator/resolveSeekResponse');
const { resolveSdjwtSeek } = require('../orchestrator/resolveSdjwtSeek');
const { isSdjwtService } = require('../orchestrator/sdjwtConfig');
const { getServiceConfig } = require('../config/serviceConfig');
const { buildSeekProcessedEvent } = require('./eventBuilder');
const { publishSeekProcessedEvent } = require('./eventProducer');

// Thin wrapper around resolveSeekResponse() that adds the audit/telemetry
// side effect the design doc asks for, without changing resolveSeekResponse
// itself. Every seek entry point (v2 sync, the legacy dev route, v1's
// in-process fallback, and the Kafka consumer's async path) calls this
// instead of resolveSeekResponse() directly, so the exact same event gets
// built and published no matter which path produced the response.
//
// USE_TELEMETRY_EVENTS gates this entirely: when false (the default), this
// is functionally identical to calling resolveSeekResponse() directly --
// nothing new is attempted, so this doesn't require Kafka or the telemetry
// ClickHouse tables to exist unless you deliberately turn it on.
async function resolveAndPublishSeek(requestBody, apiMode, apiEndpoint) {
  const transactionId = requestBody?.message?.transaction_id;
  const serviceId = requestBody?.message?.seek_request?.service_id;

  // SD-JWT is sync-only by design: a service_id flagged in aiu_sdjwt_config
  // still gets the normal GraphQL-backed flow on the async (v1) and legacy
  // routes -- only apiMode === 'SYNC' can take the SD-JWT branch.
  const useSdjwt = apiMode === 'SYNC' && await isSdjwtService(serviceId);
  if (useSdjwt) {
    console.log(`[sdjwt] service_id=${serviceId} is flagged for the SD-JWT flow -- skipping the normal GraphQL-backed resolver.`);
  }
  const resolve = () => (useSdjwt ? resolveSdjwtSeek(requestBody) : resolveSeekResponse(requestBody));

  if (process.env.USE_TELEMETRY_EVENTS !== 'true') {
    console.log(`[telemetry] USE_TELEMETRY_EVENTS is not "true" -- skipping seek-processed event for transaction ${transactionId} (${apiMode}). Set USE_TELEMETRY_EVENTS=true in .env and restart to enable this.`);
    return resolve();
  }

  const startedAt = Date.now();
  const requestId = uuidv4();
  console.log(`[telemetry] Step 1/4: New request -- requestId=${requestId}, transaction_id=${transactionId}, apiMode=${apiMode}, apiEndpoint=${apiEndpoint}`);

  console.log(`[telemetry] Step 2/4: Resolving the actual seek response (${useSdjwt ? 'SD-JWT credential flow' : 'GraphQL/ClickHouse'})...`);
  const { httpStatus, body, auditMeta } = await resolve();
  console.log(`[telemetry] Step 2/4 done: httpStatus=${httpStatus}, durationMs so far=${Date.now() - startedAt}`);

  const durationMs = Date.now() - startedAt;
  console.log(`[telemetry] Step 3/4: Looking up service config to build the audit event...`);
  const config = await getServiceConfig(serviceId);
  const event = buildSeekProcessedEvent({ requestBody, apiMode, apiEndpoint, requestId, httpStatus, body, durationMs, config, auditMeta });
  console.log(`[telemetry] Step 3/4 done: eventId=${event.eventId}, status=${event.response.status}, purposeCode=${event.request.purposeCode}, farmerCount=${event.sharing.farmerCount}, recordCount=${event.sharing.recordCount}, attributeCount=${event.sharing.sharedData.length}, durationMs=${durationMs}`);

  console.log(`[telemetry] Step 4/4: Publishing to Kafka (fire-and-forget -- does not block this response)...`);
  // Fire-and-forget: the AIU's response is already decided above. This must
  // never delay or fail the caller -- publishSeekProcessedEvent handles its
  // own retry and never throws.
  publishSeekProcessedEvent(event);

  return { httpStatus, body, requestId };
}

module.exports = { resolveAndPublishSeek };
