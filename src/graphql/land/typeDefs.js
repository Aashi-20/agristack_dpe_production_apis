const typeDefs = `#graphql
  type FarmerLand {
    frCentralId: String
    plotRegistryId: String
    farmlandId: String
    surveyNumber: String
    subSurveyNumber: String
    plotGeometry: String
    ulpin: String
    plotArea: Float
    fprLandType: String
    plotStateLgdCode: Int
    plotStateName: String
    plotVillageLgdCode: Int
    plotVillageName: String
    plotDistrictLgdCode: Int
    plotDistrictName: String
    plotSubDistrictLgdCode: Int
    plotSubDistrictName: String
    extentTotalAreaInHectare: Float
    isJointOwnership: Int
    ownerType: String
    ownershipShareType: String
    jointOwnershipShareType: String
    tenureType: String
  }

  input FilterInput {
    field: String!
    value: String!
  }

  type Query {
    farmerLand(filter: [FilterInput!]!): [FarmerLand]
  }
`;

module.exports = typeDefs;
