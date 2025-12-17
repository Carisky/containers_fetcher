import type { Attachment, ResultSet, Transaction } from "node-firebird-driver";
import { parseXmlFieldsForWysylkaRow } from "../../utils/wysylkaXml";
import {
  closeResultSetQuietly,
  rollbackQuietly,
  withFirebirdAttachment,
} from "./connection";
import { parseIsoDateOnly } from "./dateUtils";
import { mapWysylkaRowWithAllColumns } from "./wysylkaMapper";

type FirebirdRow = Record<string, unknown>;

export type RejestrSummary = {
  date: string;
  creationDate: string | null;
  pozRej: string | null;
  mrn: string | null;
  xmlDoc: string | null;
  sumavat: string | null;
  setSumVat: string | null;
  sadNumber: string | null;
  sadueId: number | null;
  sadueSupplementId: number | null;
};

const REJWPISY_ENRICHED_BY_DATE_SQL = `
  SELECT
    r.IDWPISU,
    r.NRKONWPISU,
    r.DATAWPISU,
    r.IDSADU,
    r.IDSADUUZUP,
    COALESCE(
      z_main.CELINANRSADU,
      z_supp.CELINANRSADU,
      s.NRAKT,
      s.DODIDSADU,
      s_supp.NRAKT,
      s_supp.DODIDSADU
    ) AS SAD_NUMBER,
    COALESCE(s.SUMAVAT, s_supp.SUMAVAT) AS SAD_SUM_VAT,
    COALESCE(z_main.MRN, z_supp.MRN, i_main.MRN, i_supp.MRN) AS MRN,
    COALESCE(z_main.SUMAVATZESTAWU, z_supp.SUMAVATZESTAWU) AS SET_SUM_VAT
  FROM REJWPISY r
  LEFT JOIN SADUE s ON s.IDSADUE = r.IDSADU
  LEFT JOIN SADUE s_supp ON s_supp.IDSADUE = r.IDSADUUZUP
  LEFT JOIN SADUEZESTAWY z_main ON z_main.IDMSADUE = s.IDSADUE
  LEFT JOIN SADUEZESTAWY z_supp ON z_supp.IDMSADUE = s_supp.IDSADUE
  LEFT JOIN ICS2 i_main ON i_main.IDSADU = s.IDSADUE
  LEFT JOIN ICS2 i_supp ON i_supp.IDSADU = s_supp.IDSADUE
  WHERE CAST(r.DATADEKL AS DATE) = ?
  ORDER BY r.DATAWPISU DESC, r.IDWPISU DESC
`;

const WYSYLKICELINA_LATEST_BY_DOCUMENT_SQL = `
  SELECT FIRST 1
    r.*
  FROM WYSYLKICELINA r
  WHERE r.IDDOKUMENTUZRD = ?
  ORDER BY r.ID_WYSYLKI DESC
`;

const executeSingleRowQuery = async (
  attachment: Attachment,
  transaction: Transaction,
  sql: string,
  parameters: unknown[]
): Promise<FirebirdRow | null> => {
  let resultSet: ResultSet | null = null;
  try {
    resultSet = await attachment.executeQuery(transaction, sql, parameters);
    const rows = await resultSet.fetchAsObject<FirebirdRow>();
    return rows && rows.length > 0 ? rows[0] : null;
  } finally {
    await closeResultSetQuietly(resultSet);
  }
};

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

const commitTransactionIfValid = async (
  transaction: Transaction | null
): Promise<void> => {
  if (transaction && transaction.isValid) {
    await transaction.commit();
  }
};

type WysylkaResolution = {
  mrn: string | null;
  xmlDoc: string | null;
};

export const fetchRejestrEntriesByDeclarationDate = async (
  rawDate: string
): Promise<RejestrSummary[]> => {
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

      resultSet = await attachment.executeQuery(
        transaction,
        REJWPISY_ENRICHED_BY_DATE_SQL,
        [parsedDate]
      );
      const rows = await resultSet.fetchAsObject<FirebirdRow>();
      await resultSet.close();
      resultSet = null;

      const wysylkaMrnCache = new Map<string, WysylkaResolution>();

      const resolveMrnViaWysylka = async (
        cacheKey: string,
        parameter: number | string
      ): Promise<WysylkaResolution> => {
        if (wysylkaMrnCache.has(cacheKey)) {
          return wysylkaMrnCache.get(cacheKey)!;
        }

        const wysylkaRow = await executeSingleRowQuery(
          attachment,
          transaction!,
          WYSYLKICELINA_LATEST_BY_DOCUMENT_SQL,
          [parameter]
        );
        let mrn: string | null = null;
        let xmlDoc: string | null = null;
        if (wysylkaRow) {
          const mappedRow = await mapWysylkaRowWithAllColumns(
            wysylkaRow,
            attachment,
            transaction!,
            {
              includeDocumentXml: false,
              includeResponseXml: true,
            }
          );

          const nrMrnDok = coerceToString(mappedRow["NRMRNDOK"]);
          if (nrMrnDok) {
            mrn = nrMrnDok;
          }

          if (!mrn) {
            const xmlFields = parseXmlFieldsForWysylkaRow(mappedRow);
            const odpFields = xmlFields["odpowiedzXmlFields"];
            if (
              odpFields &&
              typeof odpFields === "object" &&
              typeof odpFields["mrn"] === "string"
            ) {
              const trimmed = odpFields["mrn"].trim();
              mrn = trimmed.length > 0 ? trimmed : null;
            }
          }

          const mappedXml = coerceToString(mappedRow["odpowiedzXml"]);
          if (mappedXml && mappedXml.length > 0) {
            xmlDoc = mappedXml;
          }
        }

        const resolution: WysylkaResolution = { mrn, xmlDoc };
        wysylkaMrnCache.set(cacheKey, resolution);
        return resolution;
      };

      const resolveMrnForRow = async (
        sadueId: number | null,
        sadueSupplementId: number | null,
        pozRejValue: string | null
      ): Promise<WysylkaResolution> => {
        const empty: WysylkaResolution = { mrn: null, xmlDoc: null };
        const candidates: Array<{ cacheKey: string; parameter: number | string }> = [];

        if (sadueId !== null) {
          candidates.push({ cacheKey: `sad:${sadueId}`, parameter: sadueId });
        }

        if (sadueSupplementId !== null) {
          candidates.push({
            cacheKey: `sad-supp:${sadueSupplementId}`,
            parameter: sadueSupplementId,
          });
        }

        const parsedPozRej =
          pozRejValue && /^\d+$/.test(pozRejValue) ? Number.parseInt(pozRejValue, 10) : null;
        if (parsedPozRej !== null) {
          candidates.push({ cacheKey: `num:${parsedPozRej}`, parameter: parsedPozRej });
        }

        if (pozRejValue && pozRejValue.length > 0) {
          candidates.push({ cacheKey: `raw:${pozRejValue}`, parameter: pozRejValue });
        }

        for (const candidate of candidates) {
          const resolution = await resolveMrnViaWysylka(candidate.cacheKey, candidate.parameter);
          if (resolution.mrn) {
            return resolution;
          }
          if (!empty.xmlDoc && resolution.xmlDoc) {
            // preserve XML if we found it even without MRN, so caller can inspect
            empty.xmlDoc = resolution.xmlDoc;
          }
        }

        return empty;
      };

      const entries: RejestrSummary[] = [];

      if (rows) {
        for (const row of rows) {
          const pozRej = coerceToString(row["NRKONWPISU"]);
          const creationDate = formatDateValue(row["DATAWPISU"]);
          const sadueId = normalizeSadueId(row["IDSADU"]);
          const sadueSupplementId = normalizeSadueId(row["IDSADUUZUP"]);
          const sumavat = coerceToString(row["SAD_SUM_VAT"]);
          const setSumVat = coerceToString(row["SET_SUM_VAT"]);
          const sadNumber = coerceToString(row["SAD_NUMBER"]);
          let mrn = coerceToString(row["MRN"]);
          let xmlDoc: string | null = null;

          if (!mrn || mrn.length === 0) {
            const resolution = await resolveMrnForRow(sadueId, sadueSupplementId, pozRej);
            mrn = resolution.mrn;
            xmlDoc = resolution.xmlDoc;
          }

          entries.push({
            date: normalizedDate,
            creationDate,
            pozRej,
            mrn,
            xmlDoc,
            sumavat,
            setSumVat,
            sadNumber,
            sadueId,
            sadueSupplementId,
          });
        }
      }

      await commitTransactionIfValid(transaction);
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
