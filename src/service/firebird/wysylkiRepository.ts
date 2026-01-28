import type { Attachment, ResultSet, Transaction } from "node-firebird-driver";
import { getFirebirdConfig } from "../../config/firebirdConfig";
import {
  buildConnectOptions,
  buildConnectionUri,
  closeResultSetQuietly,
  rollbackQuietly,
  withFirebirdAttachment,
} from "./connection";
import { mapWysylkaRowWithAllColumns } from "./wysylkaMapper";
import { isIsoDateOnlyFormat, parseIsoDateOnly } from "./dateUtils";

export type FetchWysylkiByMrnOptions = {
  fileCode?: string;
  limit?: number;
  preferXml?: boolean;
  includeDocumentXml?: boolean;
  includeResponseXml?: boolean;
};

export type FetchWysylkiByDateOptions = FetchWysylkiByMrnOptions;

const SADUE_DETAILS_SQL = `
  SELECT
    r.UZYTKOWNIK,
    r.OGOLNAWARTOSC,
    r.WALUTASADU,
    r.KOMENTARZ,
    r.ZGLASZAJACY,
    r.KRAJPRZEZNACZ
  FROM SADUE r
  WHERE r.IDSADUE = ?
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

const fetchSadueDetails = async (
  attachment: Attachment,
  transaction: Transaction,
  sadueId: number
): Promise<Record<string, unknown> | null> => {
  let resultSet: ResultSet | null = null;

  try {
    resultSet = await attachment.executeQuery(
      transaction,
      SADUE_DETAILS_SQL,
      [sadueId]
    );
    const rows = await resultSet.fetchAsObject<Record<string, unknown>>();
    if (!rows || rows.length === 0) {
      return null;
    }

    return rows[0];
  } finally {
    await closeResultSetQuietly(resultSet);
  }
};

const buildQueryConditions = (
  normalizedMrn: string,
  normalizedFileCode: string,
  preferXml: boolean
) => {
  const conditions = ["r.NRMRNDOK STARTING WITH ?"];
  const parameters: unknown[] = [normalizedMrn];

  if (normalizedFileCode) {
    conditions.push("r.NAZWAPLIKU CONTAINING ?");
    parameters.push(normalizedFileCode);
  }

  if (preferXml) {
    conditions.push("UPPER(r.NAZWAPLIKU) LIKE ?");
    parameters.push("%.XML");
  }

  return { conditions, parameters } as const;
};

const buildDateQueryConditions = (
  targetDate: Date,
  normalizedFileCode: string,
  preferXml: boolean
) => {
  const conditions = ["CAST(r.DATAUTWORZENIA AS DATE) = ?"];
  const parameters: unknown[] = [targetDate];

  if (normalizedFileCode) {
    conditions.push("r.NAZWAPLIKU CONTAINING ?");
    parameters.push(normalizedFileCode);
  }

  if (preferXml) {
    conditions.push("UPPER(r.NAZWAPLIKU) LIKE ?");
    parameters.push("%.XML");
  }

  return { conditions, parameters } as const;
};

const normaliseLimit = (
  rawLimit: number | undefined,
  preferXml: boolean
): number | undefined => {
  if (rawLimit === undefined) {
    return undefined;
  }

  const candidate = Math.trunc(rawLimit);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return undefined;
  }

  return Math.min(candidate, 50);
};

export const fetchWysylkiByMrn = async (
  mrn: string,
  filterOptions: FetchWysylkiByMrnOptions = {}
): Promise<Record<string, unknown>[]> => {
  const normalizedMrn = typeof mrn === "string" ? mrn.trim() : "";
  if (!normalizedMrn) {
    throw new Error("MRN value must be a non-empty string");
  }

  const preferXml = filterOptions.preferXml === true;
  const rawLimit =
    typeof filterOptions.limit === "number" ? filterOptions.limit : Number.NaN;
  const fallbackLimit = preferXml ? 1 : 10;
  const limitCandidate = Number.isFinite(rawLimit) ? rawLimit : fallbackLimit;
  const limit = Math.min(Math.max(Math.trunc(limitCandidate), 1), 50);
  const normalizedFileCode =
    typeof filterOptions.fileCode === "string" ? filterOptions.fileCode.trim() : "";
  const includeDocumentXml =
    filterOptions.includeDocumentXml ?? !preferXml;
  const includeResponseXml =
    filterOptions.includeResponseXml ?? true;

  const { conditions, parameters } = buildQueryConditions(
    normalizedMrn,
    normalizedFileCode,
    preferXml
  );
  const whereClause = conditions.join("\n        AND ");
  const sql = `
      SELECT FIRST ${limit}
        r.*
      FROM WYSYLKICELINA r
      WHERE ${whereClause}
      ORDER BY r.ID_WYSYLKI DESC
    `;

  return withFirebirdAttachment(async ({ attachment }) => {
    let transaction: Transaction | null = null;
    let resultSet: ResultSet | null = null;

    try {
      transaction = await attachment.startTransaction();

      resultSet = await attachment.executeQuery(transaction, sql, parameters);
      const rows = await resultSet.fetchAsObject<Record<string, unknown>>();
      await resultSet.close();
      resultSet = null;

      const sadueCache = new Map<number, Record<string, unknown> | null>();
      if (!transaction || !transaction.isValid) {
        throw new Error(
          "Firebird transaction ended unexpectedly while decoding WYSYLKICELINA rows"
        );
      }

      const decodedRows: Record<string, unknown>[] = [];
      for (const row of rows) {
        const mapped = await mapWysylkaRowWithAllColumns(
          row,
          attachment,
          transaction,
          {
            includeDocumentXml,
            includeResponseXml,
          }
        );

        const sadueId = normalizeSadueId(row["IDDOKUMENTUZRD"]);
        if (sadueId !== null) {
          let sadueDetails = sadueCache.get(sadueId);
          if (sadueDetails === undefined) {
            sadueDetails = await fetchSadueDetails(
              attachment,
              transaction,
              sadueId
            );
            sadueCache.set(sadueId, sadueDetails ?? null);
          }
          mapped.sadue = sadueDetails ?? null;
        } else {
          mapped.sadue = null;
        }

        decodedRows.push(mapped);
      }

      if (transaction.isValid) {
        await transaction.commit();
      }
      transaction = null;

      return decodedRows;
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

export const fetchWysylkiByCreationDate = async (
  rawDate: string,
  filterOptions: FetchWysylkiByDateOptions = {}
): Promise<Record<string, unknown>[]> => {
  const normalizedDate = typeof rawDate === "string" ? rawDate.trim() : "";
  if (!normalizedDate) {
    throw new Error("Date value must be a non-empty string");
  }
  if (!isIsoDateOnlyFormat(normalizedDate)) {
    throw new Error(
      "Date must be provided in the ISO format YYYY-MM-DD (e.g., 2025-01-03)"
    );
  }
  const parsedDate = parseIsoDateOnly(normalizedDate);

  const preferXml = filterOptions.preferXml === true;
  const limit = normaliseLimit(filterOptions.limit, preferXml);
  const normalizedFileCode =
    typeof filterOptions.fileCode === "string" ? filterOptions.fileCode.trim() : "";
  const includeDocumentXml =
    filterOptions.includeDocumentXml ?? !preferXml;
  const includeResponseXml =
    filterOptions.includeResponseXml ?? true;

  const { conditions, parameters } = buildDateQueryConditions(
    parsedDate,
    normalizedFileCode,
    preferXml
  );
  const whereClause = conditions.join("\n        AND ");
  const selectPrefix = limit ? `SELECT FIRST ${limit}` : "SELECT";
  const sql = `
      ${selectPrefix}
        r.*
      FROM WYSYLKICELINA r
      WHERE ${whereClause}
      ORDER BY r.DATAUTWORZENIA DESC, r.ID_WYSYLKI DESC
    `;

  return withFirebirdAttachment(async ({ attachment }) => {
    let transaction: Transaction | null = null;
    let resultSet: ResultSet | null = null;

    try {
      transaction = await attachment.startTransaction();

      resultSet = await attachment.executeQuery(transaction, sql, parameters);
      const rows = await resultSet.fetchAsObject<Record<string, unknown>>();
      await resultSet.close();
      resultSet = null;

      const sadueCache = new Map<number, Record<string, unknown> | null>();
      if (!transaction || !transaction.isValid) {
        throw new Error(
          "Firebird transaction ended unexpectedly while decoding WYSYLKICELINA rows"
        );
      }

      const decodedRows: Record<string, unknown>[] = [];
      for (const row of rows) {
        const mapped = await mapWysylkaRowWithAllColumns(
          row,
          attachment,
          transaction,
          {
            includeDocumentXml,
            includeResponseXml,
          }
        );

        const sadueId = normalizeSadueId(row["IDDOKUMENTUZRD"]);
        if (sadueId !== null) {
          let sadueDetails = sadueCache.get(sadueId);
          if (sadueDetails === undefined) {
            sadueDetails = await fetchSadueDetails(
              attachment,
              transaction,
              sadueId
            );
            sadueCache.set(sadueId, sadueDetails ?? null);
          }
          mapped.sadue = sadueDetails ?? null;
        } else {
          mapped.sadue = null;
        }

        decodedRows.push(mapped);
      }

      if (transaction.isValid) {
        await transaction.commit();
      }
      transaction = null;

      return decodedRows;
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

export const checkFirebirdConnection = async (): Promise<void> => {
  const config = getFirebirdConfig();
  const uri = buildConnectionUri(config);
  const options = buildConnectOptions(config);

  await withFirebirdAttachment(async ({ attachment }) => {
    console.log(
      `[firebird] Checking connection to SADDANEIB.FDB`
    );

    if (!attachment.isValid) {
      throw new Error("Firebird attachment is not valid");
    }
  });
};

export const fetchCmrSampleRows = async (): Promise<Record<string, unknown>[]> => {
  return withFirebirdAttachment(async ({ attachment }) => {
    let transaction: Transaction | null = null;
    let resultSet: ResultSet | null = null;

    try {
      transaction = await attachment.startTransaction();

      resultSet = await attachment.executeQuery(
        transaction,
        "SELECT FIRST 10 * FROM CMR"
      );

      const rows = await resultSet.fetchAsObject<Record<string, unknown>>();
      await resultSet.close();
      resultSet = null;

      if (transaction && transaction.isValid) {
        await transaction.commit();
        transaction = null;
      }

      return rows;
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
