import type { ResultSet, Transaction } from "node-firebird-driver";
import { getFirebirdConfig } from "../../config/firebirdConfig";
import {
  buildConnectOptions,
  buildConnectionUri,
  closeResultSetQuietly,
  rollbackQuietly,
  withFirebirdAttachment,
} from "./connection";
import { mapWysylkaRowWithAllColumns } from "./wysylkaMapper";

export type FetchWysylkiByMrnOptions = {
  fileCode?: string;
  limit?: number;
  preferXml?: boolean;
  includeDocumentXml?: boolean;
  includeResponseXml?: boolean;
};

export type FetchWysylkiByDateOptions = FetchWysylkiByMrnOptions;

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
  normalizedDate: string,
  normalizedFileCode: string,
  preferXml: boolean
) => {
  const conditions = ["CAST(r.DATAUTWORZENIA AS DATE) = ?"];
  const parameters: unknown[] = [parseIsoDateOnly(normalizedDate)];

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

      if (!transaction || !transaction.isValid) {
        throw new Error(
          "Firebird transaction ended unexpectedly while decoding WYSYLKICELINA rows"
        );
      }

      const decodedRows: Record<string, unknown>[] = [];
      for (const row of rows) {
        decodedRows.push(
          await mapWysylkaRowWithAllColumns(row, attachment, transaction, {
            includeDocumentXml,
            includeResponseXml,
          })
        );
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

const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const parseIsoDateOnly = (value: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("Invalid date format. Expected YYYY-MM-DD.");
  }

  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error("Invalid date components. Expected numeric year, month, and day.");
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid calendar date. Please verify the provided value.");
  }

  return date;
};

export const fetchWysylkiByCreationDate = async (
  rawDate: string,
  filterOptions: FetchWysylkiByDateOptions = {}
): Promise<Record<string, unknown>[]> => {
  const normalizedDate = typeof rawDate === "string" ? rawDate.trim() : "";
  if (!normalizedDate) {
    throw new Error("Date value must be a non-empty string");
  }
  if (!DATE_INPUT_PATTERN.test(normalizedDate)) {
    throw new Error(
      "Date must be provided in the ISO format YYYY-MM-DD (e.g., 2025-01-03)"
    );
  }

  const preferXml = filterOptions.preferXml === true;
  const limit = normaliseLimit(filterOptions.limit, preferXml);
  const normalizedFileCode =
    typeof filterOptions.fileCode === "string" ? filterOptions.fileCode.trim() : "";
  const includeDocumentXml =
    filterOptions.includeDocumentXml ?? !preferXml;
  const includeResponseXml =
    filterOptions.includeResponseXml ?? true;

  const { conditions, parameters } = buildDateQueryConditions(
    normalizedDate,
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

      if (!transaction || !transaction.isValid) {
        throw new Error(
          "Firebird transaction ended unexpectedly while decoding WYSYLKICELINA rows"
        );
      }

      const decodedRows: Record<string, unknown>[] = [];
      for (const row of rows) {
        decodedRows.push(
          await mapWysylkaRowWithAllColumns(row, attachment, transaction, {
            includeDocumentXml,
            includeResponseXml,
          })
        );
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
      `[firebird] Checking connection to ${uri} with user ${options.username ?? "(default)"}`
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
