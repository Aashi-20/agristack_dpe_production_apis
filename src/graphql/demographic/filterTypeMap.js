// ClickHouse column type for each filterable field, so query params bind
// with the correct type (comparing an Int64 column to a String param fails).
module.exports = {
  frCentralId: 'String',
  farmerDob: 'String',
  gender: 'String',
  farmerCategory: 'String',
  farmerCasteCategory: 'String',
  frStateLgdCode: 'Int64',
  frStateName: 'String',
  frVillageLgdCode: 'Int64',
  frVillageName: 'String',
  frDistrictLgdCode: 'Int64',
  frDistrictName: 'String',
  frSubDistrictLgdCode: 'Int64',
  frSubDistrictName: 'String',
  farmerType: 'String',
};
