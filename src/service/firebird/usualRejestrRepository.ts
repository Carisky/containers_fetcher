import type { Attachment, ResultSet, Transaction } from "node-firebird-driver";
import type { ZgloszenieKod } from "../../utils/wysylkaXml";
import {
  extractAdditionalDeclarationTypeFromZcXml,
  extractMessageCodesFromXml,
  extractMrnFromXmlLoose,
  extractZgloszenieKodFromXml,
} from "../../utils/wysylkaXml";
import { closeResultSetQuietly, rollbackQuietly, withFirebirdAttachment } from "./connection";
import { parseIsoDateOnly } from "./dateUtils";
import { decodeZlibBuffer, readBlobAsBuffer } from "./xmlDecoders";

type FirebirdRow = Record<string, unknown>;

export type UsualRejestrSummary = {
  date: string;
  creationDate: string | null;
  pozRej: string | null;
  mrn: string | null;
  zgloszenieKod: ZgloszenieKod | null;
  zgloszenieKody: string[];
  xmlDoc: string | null;
  sumavat: string | null;
  setSumVat: string | null;
  sadNumber: string | null;
  ucZgloszenia: string | null;
  sadueId: number | null;
  sadueSupplementId: number | null;
  typZgloszenia: string | null;
};

const SADUE_USUAL_BY_DATE_SQL = `
  SELECT
    s.IDSADUE,
    s.GUIDSADU,
    s.DATADEKL,
    s.SUMAVAT,
    s.UCZGLOSZENIA,
    s.NRAKT,
    s.DODIDSADU,
    COALESCE(z_main.MRN, i_main.MRN) AS MRN,
    z_main.SET_SUM_VAT,
    z_main.SAD_NUMBER AS Z_SAD_NUMBER
  FROM SADUE s
  LEFT JOIN (
    SELECT
      z.IDMSADUE,
      MAX(z.MRN) AS MRN,
      MAX(z.SUMAVATZESTAWU) AS SET_SUM_VAT,
      MAX(z.CELINANRSADU) AS SAD_NUMBER
    FROM SADUEZESTAWY z
    GROUP BY z.IDMSADUE
  ) z_main ON z_main.IDMSADUE = s.IDSADUE
  LEFT JOIN ICS2 i_main ON i_main.IDSADU = s.IDSADUE
  WHERE CAST(s.DATADEKL AS DATE) = ?
    AND EXISTS (
      SELECT 1
      FROM WYSYLKICELINA w
      WHERE (w.IDDOKUMENTUZRD = s.IDSADUE OR w.GUIDDOKUMENTUZRD = s.GUIDSADU)
        AND (
          UPPER(COALESCE(w.NAZWAPLIKU, '')) STARTING WITH 'ZC428'
          OR UPPER(COALESCE(w.NAZWAPLIKU, '')) STARTING WITH 'ZC429'
        )
    )
  ORDER BY s.DATADEKL DESC, s.IDSADUE DESC
`;

const WYSYLKICELINA_ZC_LOOKBACK_LIMIT = 8;

const WYSYLKICELINA_RECENT_BY_DOCUMENT_SQL = `
  SELECT FIRST ${WYSYLKICELINA_ZC_LOOKBACK_LIMIT}
    r.ID_WYSYLKI,
    r.NAZWAPLIKU,
    r.NRWLASNYDOK,
    r.NRWLASNYKOM,
    r.DOKUMENTXML,
    r.ODPOWIEDZXML
  FROM WYSYLKICELINA r
  WHERE (r.IDDOKUMENTUZRD = ? OR r.GUIDDOKUMENTUZRD = ?)
    AND (
      UPPER(COALESCE(r.NAZWAPLIKU, '')) STARTING WITH 'ZC428'
      OR UPPER(COALESCE(r.NAZWAPLIKU, '')) STARTING WITH 'ZC429'
    )
  ORDER BY r.ID_WYSYLKI DESC
`;

const normalizeSadueId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const candidate = Number(value);
    return Number.isFinite(candidate) ? candidate : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const formatDateValue = (value: unknown): string | null => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const coerceToString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
};

type ZgloszenieResolution = {
  zgloszenieKod: ZgloszenieKod | null;
  zgloszenieKody: string[];
  typZgloszenia: string | null;
  mrn: string | null;
  xmlDoc: string | null;
};

const isAllowedTypZgloszenia = (value: string | null): boolean =>
  value === "A" || value === "C" || value === "D";

const extractZcCodeFromText = (value: string | null): ZgloszenieKod | null => {
  if (!value) {
    return null;
  }

  const normalized = value.toUpperCase();
  // Prefer ZC429 when both appear anywhere in the text.
  if (normalized.includes("ZC429")) {
    return "ZC429";
  }
  if (normalized.includes("ZC428")) {
    return "ZC428";
  }
  return null;
};

const extractCodesFromText = (value: string | null): string[] => {
  if (!value) {
    return [];
  }

  const normalized = value.toUpperCase();
  const regex = /([A-Z]{2}\d{3}[A-Z]{0,2})/g;
  const codes = new Set<string>();
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(normalized)) !== null) {
    const code = match[1];
    if (code) {
      codes.add(code);
      if (codes.size >= 30) {
        break;
      }
    }
  }
  return Array.from(codes);
};

const resolveZgloszenieKodForSadue = async (
  attachment: Attachment,
  transaction: Transaction,
  sadueId: number,
  guidSadue: string | null
): Promise<ZgloszenieResolution> => {
  let resultSet: ResultSet | null = null;
  try {
    resultSet = await attachment.executeQuery(
      transaction,
      WYSYLKICELINA_RECENT_BY_DOCUMENT_SQL,
      [sadueId, guidSadue]
    );
    const rows = await resultSet.fetchAsObject<FirebirdRow>();
    await resultSet.close();
    resultSet = null;

    const allCodes = new Set<string>();
    let best429: { xmlDoc: string; typ: string | null; mrn: string | null } | null = null;
    let best428: { xmlDoc: string; typ: string | null; mrn: string | null } | null = null;

    for (const row of rows ?? []) {
      const id = coerceToString(row["ID_WYSYLKI"]) ?? "unknown";
      const fileName = coerceToString(row["NAZWAPLIKU"]);
      const ownDoc = coerceToString(row["NRWLASNYDOK"]);
      const ownKom = coerceToString(row["NRWLASNYKOM"]);

      for (const candidateText of [fileName, ownDoc, ownKom]) {
        for (const code of extractCodesFromText(candidateText)) {
          allCodes.add(code);
        }
      }

      if (best429) {
        continue;
      }

      const responseBuffer = await readBlobAsBuffer(attachment, transaction, row["ODPOWIEDZXML"]);
      const responseDecoded = decodeZlibBuffer(
        responseBuffer,
        `WYSYLKICELINA.ID_WYSYLKI=${id} ODPOWIEDZXML`
      );
      const responseXml = responseDecoded.decoded;
      const responseCodes = responseXml ? extractMessageCodesFromXml(responseXml) : [];
      for (const code of responseCodes) {
        allCodes.add(code);
      }

      if (responseXml) {
        const code = extractZgloszenieKodFromXml(responseXml);
        if (code === "ZC429") {
          const typ = extractAdditionalDeclarationTypeFromZcXml(responseXml);
          const mrn = extractMrnFromXmlLoose(responseXml);
          best429 = { xmlDoc: responseXml, typ, mrn };
          continue;
        }
        if (code === "ZC428" && !best428) {
          best428 = {
            xmlDoc: responseXml,
            typ: extractAdditionalDeclarationTypeFromZcXml(responseXml),
            mrn: extractMrnFromXmlLoose(responseXml),
          };
          continue;
        }
      }

      const dokumentBuffer = await readBlobAsBuffer(attachment, transaction, row["DOKUMENTXML"]);
      const dokumentDecoded = decodeZlibBuffer(
        dokumentBuffer,
        `WYSYLKICELINA.ID_WYSYLKI=${id} DOKUMENTXML`
      );
      const dokumentXml = dokumentDecoded.decoded;
      if (!dokumentXml) {
        continue;
      }

      for (const code of extractMessageCodesFromXml(dokumentXml)) {
        allCodes.add(code);
      }

      const docCode = extractZgloszenieKodFromXml(dokumentXml);
      if (docCode === "ZC429") {
        const typ = extractAdditionalDeclarationTypeFromZcXml(dokumentXml);
        const mrn = extractMrnFromXmlLoose(dokumentXml);
        best429 = { xmlDoc: dokumentXml, typ, mrn };
        continue;
      }
      if (docCode === "ZC428" && !best428) {
        best428 = {
          xmlDoc: dokumentXml,
          typ: extractAdditionalDeclarationTypeFromZcXml(dokumentXml),
          mrn: extractMrnFromXmlLoose(dokumentXml),
        };
        continue;
      }
    }

    if (best429) {
      return {
        zgloszenieKod: "ZC429",
        zgloszenieKody: Array.from(allCodes),
        typZgloszenia: best429.typ,
        mrn: best429.mrn,
        xmlDoc: best429.xmlDoc,
      };
    }

    if (best428) {
      return {
        zgloszenieKod: "ZC428",
        zgloszenieKody: Array.from(allCodes),
        typZgloszenia: best428.typ,
        mrn: best428.mrn,
        xmlDoc: best428.xmlDoc.length > 0 ? best428.xmlDoc : null,
      };
    }

    return {
      zgloszenieKod: null,
      zgloszenieKody: Array.from(allCodes),
      typZgloszenia: null,
      mrn: null,
      xmlDoc: null,
    };
  } finally {
    await closeResultSetQuietly(resultSet);
  }
};

export const fetchUsualRejestrEntriesByDeclarationDate = async (
  rawDate: string
): Promise<UsualRejestrSummary[]> => {
  const normalizedDate = typeof rawDate === "string" ? rawDate.trim() : "";
  if (!normalizedDate) {
    throw new Error("Date value must be a non-empty string");
  }

  const parsedDate = parseIsoDateOnly(normalizedDate);

  return withFirebirdAttachment(async ({ attachment }) => {
    let transaction: Transaction | null = null;
    let resultSet: ResultSet | null = null;

    try {
      transaction = await attachment.startTransaction();

      resultSet = await attachment.executeQuery(transaction, SADUE_USUAL_BY_DATE_SQL, [
        parsedDate,
      ]);
      const rows = await resultSet.fetchAsObject<FirebirdRow>();
      await resultSet.close();
      resultSet = null;

      const entries: UsualRejestrSummary[] = [];

      for (const row of rows ?? []) {
        const sadueId = normalizeSadueId(row["IDSADUE"]);
        if (sadueId === null) {
          continue;
        }
        const guidSadue = coerceToString(row["GUIDSADU"]);

        const sadNumber =
          coerceToString(row["Z_SAD_NUMBER"]) ??
          coerceToString(row["NRAKT"]) ??
          coerceToString(row["DODIDSADU"]);
        const sumavat = coerceToString(row["SUMAVAT"]);
        const setSumVat = coerceToString(row["SET_SUM_VAT"]);
        const ucZgloszenia = coerceToString(row["UCZGLOSZENIA"]);
        const mrnFromJoin = coerceToString(row["MRN"]);
        const zgl = await resolveZgloszenieKodForSadue(
          attachment,
          transaction,
          sadueId,
          guidSadue
        );
        const typZgloszenia = zgl.typZgloszenia;

        if (!isAllowedTypZgloszenia(typZgloszenia)) {
          continue;
        }

        entries.push({
          date: normalizedDate,
          creationDate: formatDateValue(row["DATADEKL"]),
          pozRej: null,
          mrn: zgl.mrn ?? mrnFromJoin,
          zgloszenieKod: zgl.zgloszenieKod,
          zgloszenieKody: zgl.zgloszenieKody,
          xmlDoc: zgl.xmlDoc,
          sumavat,
          setSumVat,
          sadNumber,
          ucZgloszenia,
          sadueId,
          sadueSupplementId: null,
          typZgloszenia,
        });
      }

      if (transaction.isValid) {
        await transaction.commit();
      }
      transaction = null;

      return entries;
    } catch (error) {
      if (transaction) {
        await rollbackQuietly(transaction);
        transaction = null;
      }
      throw error;
    } finally {
      await closeResultSetQuietly(resultSet);
    }
  });
};
