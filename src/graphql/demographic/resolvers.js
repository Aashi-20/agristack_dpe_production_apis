const clickhouse = require('../../db/clickhouse');
const { getRequestedFields, projectFields, toFilterObject, buildWhereClause } = require('../../utils/graphqlFields');
const fieldMap = require('./fieldMap');
const filterTypeMap = require('./filterTypeMap');

const resolvers = {
  Query: {
    farmerDemographic: async (_parent, { filter }, _ctx, info) => {
      const requestedFields = getRequestedFields(info);
      // filter arrives as [{field, value}, ...]; validate + convert here.
      const filterObj = toFilterObject(filter, filterTypeMap);
      const where = buildWhereClause(filterObj, fieldMap, filterTypeMap);
      if (!where) {
        throw new Error('farmerDemographic requires at least one filter field (e.g. frCentralId, gender, frVillageLgdCode)');
      }

      // Only select the columns the caller actually asked for (driven by
      // whatever attribute list the AIU's config put in the GraphQL query).
      const columns = requestedFields.map((f) => fieldMap[f]).filter(Boolean);
      if (!columns.includes('fr_central_id')) columns.push('fr_central_id');

      const sql = `
        SELECT ${columns.join(', ')}
        FROM farmer_demographic_dist
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
