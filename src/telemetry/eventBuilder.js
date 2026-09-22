const { v4: uuidv4 } = require('uuid');

// Flattens each profile's configured attribute list into "profile.field"
// names, e.g. "farmerData.farmerNameEng" -- this is our stand-in for the
// document's requestedData/sharedData (e.g. "demographic.name"). Using the
// service's own config (rather than re-deriving from the response) means
// this reflects what the AIU is entitled to see, which is what "requested"
// should mean here.
function buildFlatAttributeList(config) {
  const list = [];
  const push = (profileKey, fields) => (fields || []).forEach((f) => list.push(`${profileKey}.${f}`));
  push('farmerData', config?.dataProfiles?.farmerData);
  push('landData', config?.dataProfiles?.landData);
  push('landOwnershipData', config?.dataProfiles?.landOwnershipData);
  return list;
}

// Builds the canonical seek-processed event. Same shape regardless of
// apiMode (SYNC or ASYNC) -- that field is the only thing distinguishing
// which path produced it, exactly as the design doc specifies.
//
// aiuId/aipId come from header.sender_id/header.receiver_id -- fields
// guaranteed present on every seek request per the protocol itself.
// purposeCode comes from the AIU's service config (aiu_service_config's
// service_name), NOT from an optional request field -- fixed from an
// earlier version of this function that read an almost-never-sent
// seek_request.purpose_code and defaulted to 'UNSPECIFIED' for nearly
// every real request.
function buildSeekProcessedEvent({ requestBody, apiMode, apiEndpoint, requestId, httpStatus, body, durationMs, config }) {
  const { header, message } = requestBody;
  const seekResponse = body?.message?.seek_response || [];

  const farmerIds = seekResponse.map((item) => item.farmerData?.frCentralId).filter(Boolean);
  const recordCount = seekResponse.reduce(
    (sum, item) => sum + 1 + (item.landData?.length || 0) + (item.landOwnershipData?.length || 0),
    0
  );
  const attributeList = buildFlatAttributeList(config);

  // Full per-farmer payload actually returned (real values, not just field
  // names) -- this is what lets a specific transaction's disclosure be
  // fully reconstructed later. Contains real farmer PII; see the comment
  // above farmer_data_sharing_log's sharedPayload column in
  // clickhouse/telemetry_tables.sql for the handling implications.
  const farmerPayloads = seekResponse
    .filter((item) => item.farmerData?.frCentralId)
    .map((item) => ({ frCentralId: item.farmerData.frCentralId, payload: item }));

  const isSuccess = httpStatus === 200;

  return {
    eventId: uuidv4(),
    eventType: 'SEEK_PROCESSED',
    eventVersion: '1.0',
    requestId,
    apiEndpoint,
    // correlationId ties this event back to the AIU's own transaction_id --
    // requestId (above) is DPE-internal (used as the Kafka key), separate
    // from the AIU's own tracking id.
    correlationId: message.transaction_id,
    apiMode,
    request: {
      aiuId: header.sender_id,
      aipId: header.receiver_id,
      purposeCode: config?.aiuServiceName || 'UNKNOWN_SERVICE',
      requestedData: attributeList,
      requestTimestamp: header.message_ts,
    },
    sharing: {
      farmerIds,
      sharedData: attributeList,
      farmerPayloads,
      farmerCount: farmerIds.length,
      recordCount,
    },
    response: {
      status: isSuccess ? 'SUCCESS' : 'FAILED',
      httpCode: httpStatus,
      errorCode: isSuccess ? null : (body?.error?.code || body?.header?.status_reason_code || 'ERROR'),
    },
    // outputValidity: no separate response-template/schema validation step
    // exists yet, so this is a stand-in meaning "did we produce a
    // well-formed on-seek response" (httpStatus 200) rather than a true
    // structural validation of the output.
    outputValidity: isSuccess,
    timing: {
      responseSentAt: new Date().toISOString(),
      durationMs,
    },
  };
}

module.exports = { buildSeekProcessedEvent };
