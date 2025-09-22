export type WysylkaXmlSourceKey = "odpowiedzXml" | "dokumentXml";

export type WysylkaXmlFieldConfig = {
  name: string;
  paths: readonly string[];
  description?: string;
};

export type WysylkaXmlSectionConfig = {
  source: WysylkaXmlSourceKey;
  targetKey: string;
  fields: readonly WysylkaXmlFieldConfig[];
};

export const wysylkaXmlConfig: readonly WysylkaXmlSectionConfig[] = [
  {
    source: "odpowiedzXml",
    targetKey: "odpowiedzXmlFields",
    fields: [
      {
        name: "mrn",
        paths: [
          "IE029PL.CC029C.TransitOperation.MRN",
          "IE028PL.CC028C.TransitOperation.MRN",
        ],
        description: "MRN number returned in the transit operation section.",
      },
      {
        name: "declarationType",
        paths: [
          "IE029PL.CC029C.TransitOperation.declarationType",
          "IE028PL.CC028C.TransitOperation.declarationType",
        ],
        description: "Declaration type code from the transit operation.",
      },
      {
        name: "consigneeName",
        paths: [
          "IE029PL.CC029C.Consignment.Consignee.name",
        ],
        description: "Name of the consignee from the consignment block.",
      },
      {
        name: "consignmentGrossMass",
        paths: [
          "IE029PL.CC029C.Consignment.grossMass",
        ],
        description: "Gross mass value found in the consignment section.",
      },
    ],
  },
  {
    source: "dokumentXml",
    targetKey: "dokumentXmlFields",
    fields: [
      // Add field descriptors here when dokumentXml starts containing structured XML.
    ],
  },
];