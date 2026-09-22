// Which fields an AIU is allowed to send as *search inputs* per profile,
// taken from the "Can be Input?" column in Data_sharing_interface_design.xlsx.
// The orchestrator uses this to split a multi-field seek_request.query_param
// into the right filter object for each profile's GraphQL API.
module.exports = {
  farmerData: [
    'frCentralId', 'farmerDob', 'gender', 'farmerCategory', 'farmerCasteCategory',
    'frStateLgdCode', 'frStateName', 'frVillageLgdCode', 'frVillageName',
    'frDistrictLgdCode', 'frDistrictName', 'frSubDistrictLgdCode', 'frSubDistrictName',
    'farmerType',
  ],
  landData: [
    'frCentralId', 'plotArea', 'fprLandType', 'plotStateLgdCode', 'plotStateName',
    'plotVillageLgdCode', 'plotVillageName', 'plotDistrictLgdCode', 'plotDistrictName',
    'plotSubDistrictLgdCode', 'plotSubDistrictName', 'isJointOwnership', 'ownerType',
    'ownershipShareType', 'tenureType', 'jointOwnershipShareType',
  ],
  landOwnershipData: [
    'frCentralId', 'isJointOwnership', 'ownerType', 'ownershipShareType',
  ],
};
