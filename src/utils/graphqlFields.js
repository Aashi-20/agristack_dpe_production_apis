// Reads exactly which fields the caller selected in the GraphQL query.
// This is the whole point of using GraphQL here: the config decides which
// attributes an AIU gets, and that list becomes both (a) the GraphQL field
// selection and (b) the ClickHouse SELECT column list -- one source of truth,
// no per-config SQL to hand-write.
function getRequestedFields(info) {
  const selections = info.fieldNodes[0].selectionSet.selections;
  return selections.map((s) => s.name.value);
}

// Shapes a raw ClickHouse row (snake_case columns) into a GraphQL response
// object (camelCase), keeping only the fields that were actually requested.
function projectFields(row, requestedFields, fieldMap) {
  const out = {};
  for (const camel of requestedFields) {
    out[camel] = row[fieldMap[camel]] ?? null;
  }
  return out;
}

// Turns a GraphQL [FilterInput!]! ({field, value} pairs) into a plain
// { camelFieldName: value } object, rejecting any field name that isn't in
// filterTypeMap (the allow-list for this profile). This is the runtime
// validation that replaces schema-level typing when the filter is generic.
function toFilterObject(filterList, filterTypeMap) {
  const filterObj = {};
  for (const { field, value } of filterList || []) {
    if (!filterTypeMap[field]) {
      const allowed = Object.keys(filterTypeMap).join(', ');
      throw new Error(`'${field}' is not a valid input field here. Allowed fields: ${allowed}`);
    }
    filterObj[field] = value;
  }
  return filterObj;
}

// Turns a filter object into a ClickHouse WHERE clause + parameter map,
// using only the filter keys that were actually provided. filterTypeMap
// says what ClickHouse type each filter column is, so params bind correctly
// (Int64 vs String etc) even though GraphQL always hands us strings.
function buildWhereClause(filter, fieldMap, filterTypeMap) {
  const entries = Object.entries(filter || {}).filter(
    ([, v]) => v !== undefined && v !== null
  );
  if (entries.length === 0) {
    return null;
  }
  const clauses = [];
  const params = {};
  entries.forEach(([camel, val], idx) => {
    const column = fieldMap[camel];
    const paramName = `f${idx}`;
    const chType = (filterTypeMap && filterTypeMap[camel]) || 'String';
    clauses.push(`${column} = {${paramName}:${chType}}`);
    params[paramName] = val;
  });
  return { whereSql: clauses.join(' AND '), params };
}

module.exports = { getRequestedFields, projectFields, toFilterObject, buildWhereClause };
