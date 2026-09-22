const clickhouse = require('../../db/clickhouse');
const { getRequestedFields, projectFields, toFilterObject, buildWhereClause } = require('../../utils/graphqlFields');
const fieldMap = require('./fieldMap');
const filterTypeMap = require('./filterTypeMap');

const resolvers = {
  Query: {
    farmerLandOwnership: async (_parent, { filter }, _ctx, info) => {
      const requestedFields = getRequestedFields(info);
      const filterObj = toFilterObject(filter, filterTypeMap);
      const where = buildWhereClause(filterObj, fieldMap, filterTypeMap);
      if (!where) {
        throw new Error('farmerLandOwnership requires at least one filter field (e.g. frCentralId)');
      }

      const columns = requestedFields.map((f) => fieldMap[f]).filter(Boolean);
      if (!columns.includes('fr_central_id')) columns.push('fr_central_id');

      const sql = `
        SELECT ${columns.join(', ')}
        FROM farmer_land_ownership_dist
        WHERE ${where.whereSql}
      `;

      const result = await clickhouse.query({
        query: sql,
        query_params: where.params,
        format: 'JSONEachRow',
      });
      const rows = await result.json();

      return rows.map((row) => projectFields(row, requestedFields, fieldMap));
    },
  },
};

module.exports = resolvers;
