const { createKafkaClient } = require('../kafka/client');
const { SEEK_PROCESSED_TOPIC } = require('../kafka/topics');
const { ensureTopicsExist } = require('../kafka/ensureTopics');
const { DATA_SHARING_DB } = require('../db/dataSharingDb');
const clickhouse = require('../db/clickhouse');

// Matches the *_dist naming convention used elsewhere in this project when
// writing through a Distributed table (the default). Set to '' in .env if
// you're using the single-node DDL variant (plain table names, no
// Distributed wrapper) from clickhouse/telemetry_tables.sql.
const TABLE_SUFFIX = process.env.TELEMETRY_TABLE_SUFFIX ?? '_dist';

// ClickHouse's DateTime64 columns expect a very specific text format:
// 'YYYY-MM-DD HH:MM:SS.mmm' -- space separator, no 'T', no timezone
// letter/offset. JavaScript's ISO strings (both the AIU's own
// "...+05:30"-style timestamps and our own new Date().toISOString(), which
// ends in "Z") don't match that, and ClickHouse's fast DateTime64 parser
// gets confused mid-string when it hits 'T' or a timezone suffix where it
// expected the value to already be ending -- that's the exact cause of
// "Cannot parse input: expected '\"' before: '+05:30'...". Converting
// everything through this first avoids it regardless of which source format
// the original timestamp came in as.
function toClickHouseDateTime64(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

// This is the single process that fans one seek-processed event out into
// all three projections the design doc describes. A fully separated,
// independently-scalable version would run each projection as its own
// consumer in its own consumer group (see README "what's left") -- this is
// the simpler version: one consumer group, one process, three writes per
// message.
async function startTelemetryConsumer() {
  await ensureTopicsExist();

  const kafka = createKafkaClient();
  const consumer = kafka.consumer({
    groupId: process.env.KAFKA_TELEMETRY_GROUP_ID || 'agristack-telemetry-fanout',
  });

  await consumer.connect();
  // fromBeginning: true (unlike the request-processing consumer in
  // src/kafka/consumer.js) -- this is an audit/telemetry trail, so a brand
  // new consumer group should never silently skip messages that were
  // published before it happened to start for the first time. Once this
  // group has run once, it has a committed offset and will only ever read
  // forward from there, same as any consumer group normally would.
  await consumer.subscribe({ topic: SEEK_PROCESSED_TOPIC, fromBeginning: true });

  console.log(`[telemetry] Listening on topic "${SEEK_PROCESSED_TOPIC}"... (writing to tables with suffix "${TABLE_SUFFIX}": response_log${TABLE_SUFFIX}, farmer_data_sharing_log${TABLE_SUFFIX}, telemetry_events${TABLE_SUFFIX})`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      console.log(`[telemetry] Step 1/5: Received message from "${SEEK_PROCESSED_TOPIC}" (offset ${message.offset})`);

      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch (err) {
        console.error('[telemetry] Skipping unparseable message:', err.message);
        return;
      }

      console.log(`[telemetry] Step 2/5: Parsed event -- eventId=${event.eventId}, requestId=${event.requestId}, transaction_id=${event.correlationId}, apiMode=${event.apiMode}, apiEndpoint=${event.apiEndpoint}, status=${event.response?.status}, purposeCode=${event.request?.purposeCode}, farmerCount=${event.sharing?.farmerCount}, durationMs=${event.timing?.durationMs}`);

      try {
        console.log(`[telemetry] Step 3/5: Writing response_log${TABLE_SUFFIX}...`);
        await writeResponseLog(event);
        console.log(`[telemetry] Step 3/5 done: wrote response_log${TABLE_SUFFIX} (eventId ${event.eventId})`);

        console.log(`[telemetry] Step 4/5: Writing farmer_data_sharing_log${TABLE_SUFFIX}...`);
        await writeFarmerTransparency(event);
        if (event.response.status === 'SUCCESS' && event.sharing.farmerIds?.length) {
          console.log(`[telemetry] Step 4/5 done: wrote farmer_data_sharing_log${TABLE_SUFFIX} (${event.sharing.farmerIds.length} farmer row(s))`);
        } else {
          console.log(`[telemetry] Step 4/5 skipped: farmer_data_sharing_log${TABLE_SUFFIX} (status=${event.response.status}, farmerCount=${event.sharing.farmerCount})`);
        }

        console.log(`[telemetry] Step 5/5: Writing telemetry_events${TABLE_SUFFIX}...`);
        await writeTelemetryEvent(event);
        console.log(`[telemetry] Step 5/5 done: wrote telemetry_events${TABLE_SUFFIX} (eventId ${event.eventId})`);

        console.log(`[telemetry] Done: eventId ${event.eventId} fully projected.`);
      } catch (err) {
        console.error(`[telemetry] FAILED projecting eventId ${event?.eventId}: ${err.message}`);
        console.error(err);
      }
    },
  });
}

async function writeResponseLog(event) {
  await clickhouse.insert({
    table: `${DATA_SHARING_DB}.response_log${TABLE_SUFFIX}`,
    values: [{
      eventId: event.eventId,
      requestId: event.requestId,
      transaction_id: event.correlationId,
      apiMode: event.apiMode,
      aiuId: event.request.aiuId,
      aipId: event.request.aipId,
      purposeCode: event.request.purposeCode,
      requestedData: event.request.requestedData,
      requestTimestamp: toClickHouseDateTime64(event.request.requestTimestamp),
      status: event.response.status,
      httpCode: event.response.httpCode,
      errorCode: event.response.errorCode,
      farmerCount: event.sharing.farmerCount,
      recordCount: event.sharing.recordCount,
      durationMs: event.timing.durationMs,
      responseSentAt: toClickHouseDateTime64(event.timing.responseSentAt),
    }],
    format: 'JSONEachRow',
  });
}

async function writeFarmerTransparency(event) {
  // Only log actual successful sharing -- per the design doc: "Create farmer
  // transparency entries only when data was actually shared."
  if (event.response.status !== 'SUCCESS' || !event.sharing.farmerIds?.length) return;

  // farmerPayloads carries the actual returned data per farmer (real
  // values, not just field names) -- looked up by frCentralId so each row
  // gets its own matching payload, not a shared/duplicated one.
  const payloadByFarmer = new Map(
    (event.sharing.farmerPayloads || []).map((p) => [p.frCentralId, p.payload])
  );

  const rows = event.sharing.farmerIds.map((frCentralId) => ({
    eventId: event.eventId,
    requestId: event.requestId,
    frCentralId,
    aiuId: event.request.aiuId,
    aipId: event.request.aipId,
    purposeCode: event.request.purposeCode,
    sharedData: event.sharing.sharedData,
    sharedPayload: JSON.stringify(payloadByFarmer.get(frCentralId) || null),
    status: event.response.status,
    sharedAt: toClickHouseDateTime64(event.timing.responseSentAt),
  }));

  await clickhouse.insert({
    table: `${DATA_SHARING_DB}.farmer_data_sharing_log${TABLE_SUFFIX}`,
    values: rows,
    format: 'JSONEachRow',
  });
}

async function writeTelemetryEvent(event) {
  await clickhouse.insert({
    table: `${DATA_SHARING_DB}.telemetry_events${TABLE_SUFFIX}`,
    values: [{
      eventId: event.eventId,
      requestId: event.requestId,
      apiMode: event.apiMode,
      api_endpoint: event.apiEndpoint,
      request_timestamp: toClickHouseDateTime64(event.request.requestTimestamp),
      aiuId: event.request.aiuId,
      aipId: event.request.aipId,
      purposeCode: event.request.purposeCode,
      status: event.response.status,
      output_validity: event.outputValidity ? 1 : 0,
      failure_reason: event.response.errorCode || null,
      durationMs: event.timing.durationMs,
      recordCount: event.sharing.recordCount,
      farmerCount: event.sharing.farmerCount,
      attributeCount: event.sharing.sharedData?.length || 0,
      eventTs: toClickHouseDateTime64(event.timing.responseSentAt),
    }],
    format: 'JSONEachRow',
  });
}

module.exports = { startTelemetryConsumer };
