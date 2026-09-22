// Mirrors the canonical "Farmer Data" attribute list exactly.
const typeDefs = `#graphql
  type FarmerDemographic {
    frCentralId: String
    farmerNameEng: String
    farmerNameLocal: String
    identifierNameEng: String
    identifierNameLocal: String
    farmerIdentifierRelationship: String
    farmerMobileNumber: String
    farmerAddressEnglish: String
    farmerAddressLocal: String
    farmerAadhaarHash: String
    farmerAadhaarBase64Hash: String
    farmerAadhaarMask: String
    farmerDob: String
    gender: String
    farmerPan: String
    farmerCategory: String
    farmerCasteCategory: String
    frStateLgdCode: Int
    frStateName: String
    frVillageLgdCode: Int
    frVillageName: String
    frDistrictLgdCode: Int
    frDistrictName: String
    frSubDistrictLgdCode: Int
    frSubDistrictName: String
    pmKisanId: String
    farmerType: String
  }

  # Generic filter: any field name can be sent as a string, validated at
  # runtime against filterTypeMap.js -- so adding a new searchable field is
  # a one-line server change, not a schema change. This is what makes the
  # *request* side just as dynamic as the response side already is.
  input FilterInput {
    field: String!
    value: String!
  }

  type Query {
    # A filter can match more than one farmer, so this returns a list --
    # even the single-frCentralId case is just a list of length 1.
    farmerDemographic(filter: [FilterInput!]!): [FarmerDemographic]
  }
`;

module.exports = typeDefs;
