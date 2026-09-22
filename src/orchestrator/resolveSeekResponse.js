const { v4: uuidv4 } = require('uuid');
const { getServiceConfig } = require('../config/serviceConfig');
const { isSenderMappedToService } = require('../config/senderServiceMap');
const inputFields = require('../config/inputFields');
const {
  buildDemographicQuery,
  buildLandQuery,
  buildLandOwnershipQuery,
} = require('./queryBuilder');
const { callGraphQL } = require('./graphqlExecutor');
const { errorBody } = require('../utils/apiError');

// query_param can arrive as either shape:
//   { "frCentralId": "..." }                              (flat object)
//   [ { "field": "frCentralId", "value": "..." } ]         (field/value list,
//                                                            same shape the
//                                                            GraphQL filters use)
// Both are normalized to a plain object before filtering.
function normalizeQueryParam(queryParam) {
  if (Array.isArray(queryParam)) {
    const obj = {};
    for (const { field, value } of queryParam) {
      obj[field] = value;
    }
    return obj;
  }
  return queryParam || {};
}

// Picks out only the keys from the caller's query_param that this profile
// is allowed to accept as input (per inputFields.js / the design sheet),
// then shapes them into the [{field, value}] list each GraphQL API expects.
function pickFilter(queryParamObj, profileKey) {
  const allowed = inputFields[profileKey] || [];
  const filterList = [];
  for (const key of allowed) {
    if (queryParamObj[key] !== undefined && queryParamObj[key] !== null) {
      filterList.push({ field: key, value: String(queryParamObj[key]) });
    }
  }
  return filterList;
}

// The actual "go do the work" logic for a seek request: look up the AIU's
// config, call the profile GraphQL APIs with whatever inputs were given, and
// assemble the on-seek response body. This is intentionally separate from
// any HTTP handling -- both the synchronous (v2) and asynchronous (v1) seek
// endpoints call this same function; they only differ in when and how they
// send the result back (see src/seek/).
//
// Returns { httpStatus, body }. The caller decides what to do with that:
// send it straight back as the HTTP response (sync), or POST it to
// header.sender_uri as the on-seek callback (async).
async function resolveSeekResponse({ header, message }) {
  const { service_id: serviceId, query_param: rawQueryParam } = message.seek_request;
  const queryParam = normalizeQueryParam(rawQueryParam);

  // Confirms header.sender_id is actually authorized to use this specific
  // service_id -- without this, a valid service_id alone (even one that
  // isn't yours) would be enough to get that service's attribute access.
  const senderId = header.sender_id;
  const isMapped = await isSenderMappedToService(senderId, serviceId);
  if (!isMapped) {
    return {
      httpStatus: 403,
      body: {
        header: { ...header, action: 'on-seek', status: 'failed', status_reason_code: 'SENDER_NOT_MAPPED_TO_SERVICE' },
        message: { transaction_id: message.transaction_id },
        error: errorBody('SENDER_NOT_MAPPED_TO_SERVICE', `sender_id '${senderId}' is not authorized to use service_id '${serviceId}'.`),
      },
    };
  }

  const config = await getServiceConfig(serviceId);
  if (!config) {
    return {
      httpStatus: 400,
      body: {
        header: { ...header, action: 'on-seek', status: 'failed', status_reason_code: 'UNKNOWN_SERVICE_ID' },
        message: { transaction_id: message.transaction_id },
        error: errorBody('UNKNOWN_SERVICE_ID', `service_id '${serviceId}' is not recognized.`),
      },
    };
  }

  let matchedFarmers = [];

  if (config.dataProfiles.farmerData?.length) {
    const demographicFilter = pickFilter(queryParam, 'farmerData');
    if (demographicFilter.length === 0) {
      return {
        httpStatus: 400,
        body: {
          header: { ...header, action: 'on-seek', status: 'failed', status_reason_code: 'MISSING_INPUT' },
          message: { transaction_id: message.transaction_id },
          error: errorBody('MISSING_INPUT', 'At least one input field is required (e.g. frCentralId, gender, frVillageLgdCode)'),
        },
      };
    }
    const query = buildDemographicQuery(config.dataProfiles.farmerData);
    const data = await callGraphQL('farmerData', query, { filter: demographicFilter });
    matchedFarmers = data.farmerDemographic || [];
  }

  const seekResponseItems = [];

  for (const farmer of matchedFarmers) {
    const item = { farmerData: farmer };
    const frCentralId = farmer.frCentralId;

    if (config.dataProfiles.landData?.length) {
      const landFilter = [...pickFilter(queryParam, 'landData'), { field: 'frCentralId', value: frCentralId }];
      const query = buildLandQuery(config.dataProfiles.landData);
      const data = await callGraphQL('landData', query, { filter: landFilter });
      item.landData = data.farmerLand;
    }

    if (config.dataProfiles.landOwnershipData?.length) {
      const landOwnershipFilter = [...pickFilter(queryParam, 'landOwnershipData'), { field: 'frCentralId', value: frCentralId }];
      const query = buildLandOwnershipQuery(config.dataProfiles.landOwnershipData);
      const data = await callGraphQL('landOwnershipData', query, { filter: landOwnershipFilter });
      item.landOwnershipData = data.farmerLandOwnership;
    }

    seekResponseItems.push(item);
  }

  return {
    httpStatus: 200,
    body: {
      header: {
        action: 'on-seek',
        completed_count: seekResponseItems.length,
        is_msg_encrypted: false,
        message_id: uuidv4(),
        message_ts: new Date().toISOString(),
        receiver_id: header.sender_id,
        sender_id: header.receiver_id,
        status: 'succeed',
        status_reason_code: 'NA',
        total_count: seekResponseItems.length,
        version: header.version,
      },
      message: {
        seek_response: seekResponseItems,
        transaction_id: message.transaction_id,
      },
      signature: 'demo-signature-abc',
    },
  };
}

module.exports = { resolveSeekResponse };
