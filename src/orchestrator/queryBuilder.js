// Turns a field list (from the AIU's response config) into a GraphQL query
// string against each profile's generic filter-based query. The filter
// itself is a [FilterInput!]! ({field, value} pairs) built in resolveSeekResponse.js.

function buildDemographicQuery(fields) {
  return `query($filter: [FilterInput!]!) {
    farmerDemographic(filter: $filter) {
      ${fields.join('\n      ')}
    }
  }`;
}

function buildLandQuery(fields) {
  return `query($filter: [FilterInput!]!) {
    farmerLand(filter: $filter) {
      ${fields.join('\n      ')}
    }
  }`;
}

function buildLandOwnershipQuery(fields) {
  return `query($filter: [FilterInput!]!) {
    farmerLandOwnership(filter: $filter) {
      ${fields.join('\n      ')}
    }
  }`;
}

module.exports = { buildDemographicQuery, buildLandQuery, buildLandOwnershipQuery };
