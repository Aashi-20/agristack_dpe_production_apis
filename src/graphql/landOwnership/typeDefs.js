const typeDefs = `#graphql
  type FarmerLandOwnership {
    frCentralId: String
    plotRegistryId: String
    farmerLandOwnershipRegistryId: String
    farmlandId: String
    surveyNumber: String
    subSurveyNumber: String
    plotStateLgdCode: Int
    plotStateName: String
    plotVillageLgdCode: Int
    plotVillageName: String
    plotDistrictLgdCode: Int
    plotDistrictName: String
    plotSubDistrictLgdCode: Int
    plotSubDistrictName: String
    mainOwnerNoAsPerRor: Int
    ownerNoAsPerRor: String
    ownerNamePerRor: String
    ownerIdentifierNamePerRor: String
    extentAssignAreaInHectare: Float
    extentTotalAreaInHectare: Float
    isJointOwnership: Int
    ownerType: String
    ownershipShareType: String
    jointOwnershipShareType: String
  }

  input FilterInput {
    field: String!
    value: String!
  }

  type Query {
    farmerLandOwnership(filter: [FilterInput!]!): [FarmerLandOwnership]
  }
`;

module.exports = typeDefs;
