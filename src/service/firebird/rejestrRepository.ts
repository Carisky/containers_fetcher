import type { Attachment, ResultSet, Transaction } from "node-firebird-driver";
import {
  extractZgloszenieKodFromXml,
  parseXmlFieldsForWysylkaRow,
  type ZgloszenieKod,
} from "../../utils/wysylkaXml";
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
  zgloszenieKod: ZgloszenieKod | null;
  xmlDoc: string | null;
  sumavat: string | null;
  setSumVat: string | null;
  sadNumber: string | null;
  ucZgloszenia: string | null;
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
      z_supp.CELINANRSADU,
      z_main.CELINANRSADU,
      s_supp.NRAKT,
      s_supp.DODIDSADU,
      s.NRAKT,
      s.DODIDSADU
    ) AS SAD_NUMBER,
    COALESCE(s_supp.SUMAVAT, s.SUMAVAT) AS SAD_SUM_VAT,
    COALESCE(s_supp.UCZGLOSZENIA, s.UCZGLOSZENIA) AS UCZGLOSZENIA,
    COALESCE(z_supp.MRN, z_main.MRN, i_supp.MRN, i_main.MRN) AS MRN,
    COALESCE(z_supp.SUMAVATZESTAWU, z_main.SUMAVATZESTAWU) AS SET_SUM_VAT
  FROM REJWPISY r
  LEFT JOIN SADUE s ON s.IDSADUE = r.IDSADU
  LEFT JOIN SADUE s_supp ON s_supp.IDSADUE = r.IDSADUUZUP
  LEFT JOIN SADUEZESTAWY z_main ON z_main.IDMSADUE = s.IDSADUE
  LEFT JOIN SADUEZESTAWY z_supp ON z_supp.IDMSADUE = s_supp.IDSADUE
  LEFT JOIN ICS2 i_main ON i_main.IDSADU = s.IDSADUE
  LEFT JOIN ICS2 i_supp ON i_supp.IDSADU = s_supp.IDSADUE
  WHERE CAST(s.DATADEKL AS DATE) = ?
     OR CAST(s_supp.DATADEKL AS DATE) = ?
     OR CAST(r.DATADEKL AS DATE) = ?
  ORDER BY r.DATAWPISU DESC, r.IDWPISU DESC
`;

const WYSYLKICELINA_LOOKBACK_LIMIT = 15;

const WYSYLKICELINA_RECENT_BY_DOCUMENT_SQL = `
  SELECT FIRST ${WYSYLKICELINA_LOOKBACK_LIMIT}
    r.*
  FROM WYSYLKICELINA r
  WHERE r.IDDOKUMENTUZRD = ?
  ORDER BY r.ID_WYSYLKI DESC
`;

const executeRowsQuery = async (
  attachment: Attachment,
  transaction: Transaction,
  sql: string,
  parameters: unknown[]
): Promise<FirebirdRow[]> => {
  let resultSet: ResultSet | null = null;
  try {
    resultSet = await attachment.executeQuery(transaction, sql, parameters);
    const rows = await resultSet.fetchAsObject<FirebirdRow>();
    return rows ?? [];
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

const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
};

const extractMrnYearPrefix = (mrn: string): string | null => {
  const match = /^(\d{2})[A-Z]{2}/i.exec(mrn.trim());
  return match ? match[1] : null;
};

const matchesExpectedMrnYear = (mrn: string, expectedYearSuffix: string): boolean =>
  extractMrnYearPrefix(mrn) === expectedYearSuffix;

const selectPreferredMrn = (
  preferWysylkiMrn: boolean,
  expectedYearSuffix: string,
  sourceMrn: string | null,
  resolvedMrn: string | null
): string | null => {
  const candidates = preferWysylkiMrn
    ? [resolvedMrn, sourceMrn]
    : [sourceMrn, resolvedMrn];

  const matching = candidates.find(
    (candidate) =>
      candidate !== null &&
      candidate.length > 0 &&
      matchesExpectedMrnYear(candidate, expectedYearSuffix)
  );
  if (matching) {
    return matching;
  }

  return candidates.find((candidate) => candidate !== null && candidate.length > 0) ?? null;
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
  const expectedYearSuffix = normalizedDate.slice(2, 4);
  const preferWysylkiMrn = parseBooleanEnv(
    process.env.REJESTR_PREFER_WYSYLKICELINA_MRN,
    true
  );

  return withFirebirdAttachment(async ({ attachment }) => {
    let transaction: Transaction | null = null;
    let resultSet: ResultSet | null = null;

    try {
      transaction = await attachment.startTransaction();

      resultSet = await attachment.executeQuery(
        transaction,
        REJWPISY_ENRICHED_BY_DATE_SQL,
        [parsedDate, parsedDate, parsedDate]
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

        const wysylkaRows = await executeRowsQuery(
          attachment,
          transaction!,
          WYSYLKICELINA_RECENT_BY_DOCUMENT_SQL,
          [parameter]
        );
        let fallbackMrn: string | null = null;
        let fallbackXml: string | null = null;

        const decodeXmlForRow = async (
          row: FirebirdRow
        ): Promise<{ mrn: string | null; xmlDoc: string | null }> => {
          const mappedRow = await mapWysylkaRowWithAllColumns(
            row,
            attachment,
            transaction!,
            {
              includeDocumentXml: false,
              includeResponseXml: true,
            }
          );

          let mrnFromXml: string | null = null;
          const xmlFields = parseXmlFieldsForWysylkaRow(mappedRow);
          const odpFields = xmlFields["odpowiedzXmlFields"];
          if (
            odpFields &&
            typeof odpFields === "object" &&
            typeof odpFields["mrn"] === "string"
          ) {
            const trimmed = odpFields["mrn"].trim();
            mrnFromXml = trimmed.length > 0 ? trimmed : null;
          }

          const mappedXml = coerceToString(mappedRow["odpowiedzXml"]);
          return {
            mrn: mrnFromXml,
            xmlDoc: mappedXml && mappedXml.length > 0 ? mappedXml : null,
          };
        };

        for (const wysylkaRow of wysylkaRows) {
          const nrMrnDok = coerceToString(wysylkaRow["NRMRNDOK"]);
          if (nrMrnDok) {
            if (!fallbackMrn) {
              fallbackMrn = nrMrnDok;
            }

            if (matchesExpectedMrnYear(nrMrnDok, expectedYearSuffix)) {
              const decoded = await decodeXmlForRow(wysylkaRow);
              const resolution: WysylkaResolution = {
                mrn: nrMrnDok,
                xmlDoc: decoded.xmlDoc,
              };
              wysylkaMrnCache.set(cacheKey, resolution);
              return resolution;
            }
          }

          const decoded = await decodeXmlForRow(wysylkaRow);
          if (decoded.xmlDoc && !fallbackXml) {
            fallbackXml = decoded.xmlDoc;
          }

          if (decoded.mrn) {
            if (!fallbackMrn) {
              fallbackMrn = decoded.mrn;
            }

            if (matchesExpectedMrnYear(decoded.mrn, expectedYearSuffix)) {
              const resolution: WysylkaResolution = {
                mrn: decoded.mrn,
                xmlDoc: decoded.xmlDoc,
              };
              wysylkaMrnCache.set(cacheKey, resolution);
              return resolution;
            }
          }
        }

        const resolution: WysylkaResolution = { mrn: fallbackMrn, xmlDoc: fallbackXml };
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

        if (sadueSupplementId !== null) {
          candidates.push({
            cacheKey: `sad-supp:${sadueSupplementId}`,
            parameter: sadueSupplementId,
          });
        }

        if (sadueId !== null) {
          candidates.push({ cacheKey: `sad:${sadueId}`, parameter: sadueId });
        }

        if (sadueId === null && sadueSupplementId === null) {
          const parsedPozRej =
            pozRejValue && /^\d+$/.test(pozRejValue) ? Number.parseInt(pozRejValue, 10) : null;
          if (parsedPozRej !== null) {
            candidates.push({ cacheKey: `num:${parsedPozRej}`, parameter: parsedPozRej });
          }

          if (pozRejValue && pozRejValue.length > 0) {
            candidates.push({ cacheKey: `raw:${pozRejValue}`, parameter: pozRejValue });
          }
        }

        let fallback: WysylkaResolution = { mrn: null, xmlDoc: null };
        for (const candidate of candidates) {
          const resolution = await resolveMrnViaWysylka(candidate.cacheKey, candidate.parameter);
          if (resolution.mrn && matchesExpectedMrnYear(resolution.mrn, expectedYearSuffix)) {
            return resolution;
          }
          if (!fallback.mrn && resolution.mrn) {
            fallback = { ...fallback, mrn: resolution.mrn };
          }
          if (!fallback.xmlDoc && resolution.xmlDoc) {
            // preserve XML if we found it even without MRN, so caller can inspect
            fallback = { ...fallback, xmlDoc: resolution.xmlDoc };
          }
        }

        return fallback.mrn || fallback.xmlDoc ? fallback : empty;
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
          const ucZgloszenia = coerceToString(row["UCZGLOSZENIA"]);
          const sourceMrn = coerceToString(row["MRN"]);
          let xmlDoc: string | null = null;
          const sourceHasExpectedYear =
            sourceMrn && sourceMrn.length > 0
              ? matchesExpectedMrnYear(sourceMrn, expectedYearSuffix)
              : false;

          if (sourceMrn && !sourceHasExpectedYear) {
            console.warn(
              `[rejestr] MRN year mismatch for ${normalizedDate}. ` +
                `source=REJWPISY mrn=${sourceMrn} sadueId=${sadueId ?? "null"} ` +
                `sadueSupplementId=${sadueSupplementId ?? "null"} pozRej=${pozRej ?? "null"}`
            );
          }

          const resolution = await resolveMrnForRow(sadueId, sadueSupplementId, pozRej);
          const resolvedMrn = resolution.mrn;
          const resolvedHasExpectedYear =
            resolvedMrn && resolvedMrn.length > 0
              ? matchesExpectedMrnYear(resolvedMrn, expectedYearSuffix)
              : false;
          if (resolvedMrn && !resolvedHasExpectedYear) {
            console.warn(
              `[rejestr] MRN year mismatch for ${normalizedDate}. ` +
                `source=WYSYLKICELINA mrn=${resolvedMrn} sadueId=${sadueId ?? "null"} ` +
                `sadueSupplementId=${sadueSupplementId ?? "null"} pozRej=${pozRej ?? "null"}`
            );
          }

          if (sourceMrn && resolvedMrn && sourceMrn !== resolvedMrn) {
            console.warn(
              `[rejestr] MRN differs for ${normalizedDate}. ` +
                `source=REJWPISY mrn=${sourceMrn} resolved=WYSYLKICELINA mrn=${resolvedMrn} ` +
                `sadueId=${sadueId ?? "null"} sadueSupplementId=${sadueSupplementId ?? "null"} ` +
                `pozRej=${pozRej ?? "null"}`
            );
          }

          const forceWysylkiForSupplement = sadueSupplementId !== null;
          const mrn = selectPreferredMrn(
            preferWysylkiMrn || forceWysylkiForSupplement,
            expectedYearSuffix,
            sourceMrn,
            resolvedMrn
          );
          if (mrn && !matchesExpectedMrnYear(mrn, expectedYearSuffix)) {
            console.warn(
              `[rejestr] MRN year mismatch for ${normalizedDate}. ` +
                `selected=${mrn} expectedYear=${expectedYearSuffix} ` +
                `sourceMrn=${sourceMrn ?? "null"} resolvedMrn=${resolvedMrn ?? "null"} ` +
                `sadueId=${sadueId ?? "null"} sadueSupplementId=${sadueSupplementId ?? "null"} ` +
                `pozRej=${pozRej ?? "null"}`
            );
          }

          if (resolution.xmlDoc) {
            xmlDoc = resolution.xmlDoc;
          }

          const zgloszenieKod = xmlDoc ? extractZgloszenieKodFromXml(xmlDoc) : null;
          const responseMrn =
            zgloszenieKod === "ZC428" ? "zgloszenie zarejestrowane (ZC428)" : mrn;

          entries.push({
            date: normalizedDate,
            creationDate,
            pozRej,
            mrn: responseMrn,
            zgloszenieKod,
            xmlDoc,
            sumavat,
            setSumVat,
            sadNumber,
            ucZgloszenia,
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
