export type WysylkaXmlSourceKey = "odpowiedzXml" | "dokumentXml";

export type WysylkaXmlFieldAggregator =
  | "houseConsignmentSupportingDocumentsSum"
  | "transitOperationReleaseDateValue";

export type WysylkaXmlFieldConfig = {
  name: string;
  paths: readonly string[];
  regex?: string;
  description?: string;
  aggregate?: WysylkaXmlFieldAggregator;
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
          "IE045PL.CC045C.TransitOperation.MRN",
        ],
        regex: "^[A-Z0-9]{18}$",
        description: "MRN number returned in the transit operation section.",
      },
      {
        name: "declarationType",
        paths: [
          "IE029PL.CC029C.TransitOperation.declarationType",
          "IE028PL.CC028C.TransitOperation.declarationType",
        ],
        regex: "^[A-Z0-9]{1,4}$",
        description: "Declaration type code from the transit operation.",
      },
      {
        name: "consigneeName",
        paths: [
          "IE029PL.CC029C.Consignment.Consignee.name",
          "IE045PL.CC045C.HolderOfTheTransitProcedure.name",
        ],
        regex: ".+",
        description: "Name of the consignee from the consignment block.",
      },
      {
        name: "consignmentGrossMass",
        paths: [
          "IE029PL.CC029C.Consignment.grossMass",
        ],
        regex: "^\\d+(?:\\.\\d+)?$",
        description: "Gross mass value found in the consignment section.",
      },
      {
        name: "guaranteeAmount",
        paths: [
          "IE029PL.CC029C.Guarantee.GuaranteeReference.amountToBeCovered",
          "IE028PL.CC028C.Guarantee.GuaranteeReference.amountToBeCovered",
        ],
        regex: "^\\d+(?:\\.\\d+)?$",
        description: "Guarantee amount to be covered.",
      },
      {
        name: "guaranteeCurrency",
        paths: [
          "IE029PL.CC029C.Guarantee.GuaranteeReference.currency",
          "IE028PL.CC028C.Guarantee.GuaranteeReference.currency",
        ],
        regex: "^[A-Z]{3}$",
        description: "Guarantee currency code.",
      },
      {
        name: "deliveryDate",
        paths: [
          "IE029PL.CountrySpecificDataPL.DeclarationSubmissionDate",
          "IE029PL.CC029C.CountrySpecificDataPL.DeclarationSubmissionDate",
          "IE029PL.CountrySpecificDataPL.DeliveryDate",
          "IE029PL.CC029C.CountrySpecificDataPL.DeliveryDate",
          "IE028PL.CC028C.CountrySpecificDataPL.DeclarationSubmissionDate",
          "IE028PL.CC028C.CountrySpecificDataPL.DeliveryDate",
        ],
        regex: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Delivery date returned in the country specific data.",
      },
      {
        name: "grn",
        paths: [
          "IE029PL.CC029C.Guarantee.GuaranteeReference.GRN",
          "IE028PL.CC028C.Guarantee.GuaranteeReference.GRN",
        ],
        regex: "^[A-Z0-9]+$",
        description: "Guarantee reference number (GRN) for the guarantee entry.",
      },
      {
        name: "closeDate",
        paths: [
          "IE045PL.CC045C.TransitOperation.writeOffDate",
          "IE029PL.CC029C.TransitOperation.writeOffDate",
        ],
        regex: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Transit close date extracted from writeOffDate in IE045.",
      },
      {
        name: "releaseDate",
        aggregate: "transitOperationReleaseDateValue",
        paths: [
          "IE029PL.CC029C.ControlResult.date",
          "IE028PL.CC028C.ControlResult.date",
          "IE045PL.CC045C.ControlResult.date",
          "IE029PL.CC029C.CountrySpecificDataPL.ReleaseDate",
          "IE029PL.CountrySpecificDataPL.ReleaseDate",
          "IE028PL.CC028C.CountrySpecificDataPL.ReleaseDate",
          "IE045PL.CC045C.CountrySpecificDataPL.ReleaseDate",
          "IE029PL.CC029C.TransitOperation.releaseDate",
        ],
        regex: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Release date reported in the country specific data block.",
      },
      {
        name: "controlResultDate",
        paths: [
          "IE029PL.CC029C.ControlResult.date",
          "IE045PL.CC045C.ControlResult.date",
        ],
        regex: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Control result date from the transit message.",
      },
      {
        name: "customsOfficeOfDepartureReferenceNumber",
        paths: [
          "IE029PL.CC029C.CustomsOfficeOfDeparture.referenceNumber",
          "IE028PL.CC028C.CustomsOfficeOfDeparture.referenceNumber",
        ],
        regex: "^[A-Z0-9]+$",
        description:
          "Reference number of the declared customs office of departure.",
      },
      {
        name: "customsOfficeOfDestinationDeclaredReferenceNumber",
        paths: [
          "IE029PL.CC029C.CustomsOfficeOfDestinationDeclared.referenceNumber",
          "IE028PL.CC028C.CustomsOfficeOfDestinationDeclared.referenceNumber",
        ],
        regex: "^[A-Z0-9]+$",
        description:
          "Reference number of the declared customs office of destination.",
      },
      {
        name: "guaranteeAmountToBeCovered",
        paths: [
          "IE029PL.CC029C.Guarantee.GuaranteeReference.amountToBeCovered",
          "IE028PL.CC028C.Guarantee.GuaranteeReference.amountToBeCovered",
        ],
        regex: "^\\d+(?:\\.\\d+)?$",
        description: "Total guarantee amount to be covered.",
      },
      {
        name: "activeBorderTransportMeansIdentificationNumber",
        paths: [
          "IE029PL.CC029C.ActiveBorderTransportMeans.identificationNumber",
          "IE028PL.CC028C.ActiveBorderTransportMeans.identificationNumber",
          "IE045PL.CC045C.ActiveBorderTransportMeans.identificationNumber",
          "IE029PL.CC029C.Consignment.ActiveBorderTransportMeans.identificationNumber",
        ],
        regex: "^[A-Z0-9\\- ]+$",
        description:
          "Identification number of the active border transport means.",
      },
      {
        name: "houseConsignmentSupportingDocumentsSum",
        paths: [],
        description:
          "Sum of HouseConsignment/ConsignmentItem supporting document complement values.",
        aggregate: "houseConsignmentSupportingDocumentsSum",
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



