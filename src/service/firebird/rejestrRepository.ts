import type { Attachment, ResultSet, Transaction } from "node-firebird-driver";
import { parseXmlFieldsForWysylkaRow } from "../../utils/wysylkaXml";
import {
  closeResultSetQuietly,
  rollbackQuietly,
  withFirebirdAttachment,
} from "./connection";
import { parseIsoDateOnly } from "./dateUtils";

type FirebirdRow = Record<string, unknown>;

export type RejestrSummary = {
  date: string;
  creationDate: string | null;
  pozRej: string | null;
  mrn: string | null;
  sumavat: string | null;
  sadueId: number | null;
};

const REJWPISY_BY_DATE_SQL = `
  SELECT
    r.IDWPISU,
    r.NRKONWPISU,
    r.DATAWPISU,
    r.IDSADU
  FROM REJWPISY r
  WHERE CAST(r.DATADEKL AS DATE) = ?
  ORDER BY r.DATAWPISU DESC, r.IDWPISU DESC
`;

const SADUE_SUMAVAT_SQL = `
  SELECT
    r.SUMAVAT
  FROM SADUE r
  WHERE r.IDSADUE = ?
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
        REJWPISY_BY_DATE_SQL,
        [parsedDate]
      );
      const rows = await resultSet.fetchAsObject<FirebirdRow>();
      await resultSet.close();
      resultSet = null;

      const sadueCache = new Map<number, string | null>();
      const wysylkaMrnCache = new Map<string, string | null>();

      const resolveSadueSumavat = async (id: number): Promise<string | null> => {
        if (sadueCache.has(id)) {
          return sadueCache.get(id) ?? null;
        }
        const sadueRow = await executeSingleRowQuery(
          attachment,
          transaction!,
          SADUE_SUMAVAT_SQL,
          [id]
        );
        const sumavat = sadueRow ? coerceToString(sadueRow["SUMAVAT"]) : null;
        sadueCache.set(id, sumavat);
        return sumavat;
      };

      const resolveMrnForDocument = async (doc: string): Promise<string | null> => {
        if (wysylkaMrnCache.has(doc)) {
          return wysylkaMrnCache.get(doc) ?? null;
        }
        const wysylkaRow = await executeSingleRowQuery(
          attachment,
          transaction!,
          WYSYLKICELINA_LATEST_BY_DOCUMENT_SQL,
          [doc]
        );
        let mrn: string | null = null;
        if (wysylkaRow) {
          const xmlFields = parseXmlFieldsForWysylkaRow(wysylkaRow);
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
        wysylkaMrnCache.set(doc, mrn);
        return mrn;
      };

      const entries: RejestrSummary[] = [];

      if (rows) {
        for (const row of rows) {
          const pozRej = coerceToString(row["NRKONWPISU"]);
          const creationDate = formatDateValue(row["DATAWPISU"]);
          const sadueId = normalizeSadueId(row["IDSADU"]);

          const sumavat =
            sadueId !== null ? await resolveSadueSumavat(sadueId) : null;

          const mrn =
            pozRej && pozRej.length > 0
              ? await resolveMrnForDocument(pozRej)
              : null;

          entries.push({
            date: normalizedDate,
            creationDate,
            pozRej,
            mrn,
            sumavat,
            sadueId,
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
