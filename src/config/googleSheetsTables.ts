export interface GoogleSheetsTableDefinition {
  key: string;
  gid: string;
  id: string;
  sheetName?: string;
}

export type GoogleSheetsTablesConfig = Record<
  string,
  GoogleSheetsTableDefinition
>;

export interface GoogleSheetsTable {
  configKey: string;
  key: string;
  gid: string;
  gidNumber: number | null;
  id: string;
  sheetName?: string;
}

export const GOOGLE_SHEETS_TABLES: GoogleSheetsTablesConfig = {
  ROZLICZENIE_T1: {
    key: "ROZLICZENIE T1",
    gid: "1723757569",
    id: "1rqouhd9J_VDkOSClLL-P54zT602IJSlmGX2YOAXAgPE",
  },
  T1_UA_CC_UKR: {
    key: "T1_UA_CC_UKR",
    gid: "1296404079",
    id: "1rqouhd9J_VDkOSClLL-P54zT602IJSlmGX2YOAXAgPE",
  },
  T1_OBCE: {
    key: "T1_UA_CC_UKR",
    gid: "1329153243",
    id: "1rqouhd9J_VDkOSClLL-P54zT602IJSlmGX2YOAXAgPE",
  },
  PLAN: {
    key: "PLAN",
    gid: "245754731",
    id: "1rqouhd9J_VDkOSClLL-P54zT602IJSlmGX2YOAXAgPE",
  },
  T1_UA_UKR: {
    key: "T1_UA_UKR",
    gid: "1276504316",
    id: "1rqouhd9J_VDkOSClLL-P54zT602IJSlmGX2YOAXAgPE",
  },
  T1_UA_WCT: {
    key: "T1_UA_WCT",
    gid: "404196714",
    id: "1rqouhd9J_VDkOSClLL-P54zT602IJSlmGX2YOAXAgPE",
  },
  SALDO_DOSTEPNE: {
    key: "SALDO DOSTĘPNE",
    gid: "406314594",
    id: "1rqouhd9J_VDkOSClLL-P54zT602IJSlmGX2YOAXAgPE",
  },
  TT_statystyka: {
    key: "TT statystyka",
    gid: "1799767468",
    id: "1rqouhd9J_VDkOSClLL-P54zT602IJSlmGX2YOAXAgPE",
  },
  Listy: {
    key: "Listy",
    gid: "1835663426",
    id: "1rqouhd9J_VDkOSClLL-P54zT602IJSlmGX2YOAXAgPE",
  },
};

const normalizeString = (value: string): string =>
  value.normalize("NFKD").replace(/\s+/g, " ").trim().toLowerCase();

const toGidNumber = (gid: string): number | null => {
  const parsed = Number.parseInt(gid, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const tables: GoogleSheetsTable[] = Object.entries(GOOGLE_SHEETS_TABLES).map(
  ([configKey, entry]) => ({
    configKey,
    key: entry.key,
    gid: entry.gid,
    gidNumber: toGidNumber(entry.gid),
    id: entry.id,
    sheetName: entry.sheetName,
  })
);

const tablesByConfigKey = new Map<string, GoogleSheetsTable>(
  tables.map((table) => [normalizeString(table.configKey), table])
);

const tablesByKey = new Map<string, GoogleSheetsTable>(
  tables.map((table) => [normalizeString(table.key), table])
);

const tablesById = new Map<string, GoogleSheetsTable>(
  tables.map((table) => [normalizeString(table.id), table])
);

const tablesByGid = new Map<string, GoogleSheetsTable>(
  tables.map((table) => [table.gid, table])
);

const tablesByGidNumber = new Map<number, GoogleSheetsTable>(
  tables
    .filter((table) => table.gidNumber !== null)
    .map((table) => [table.gidNumber as number, table])
);

type LookupMode = "config" | "key" | "id" | "gid";

const resolveMode = (raw?: string): LookupMode | undefined => {
  if (!raw) {
    return undefined;
  }

  const value = normalizeString(raw);
  if (["config", "internal", "name"].includes(value)) {
    return "config";
  }
  if (
    [
      "key",
      "alias",
      "friendly",
      "friendly-name",
      "user-friendly-name",
    ].includes(value)
  ) {
    return "key";
  }
  if (["id", "spreadsheet", "spreadsheet-id"].includes(value)) {
    return "id";
  }
  if (["gid", "sheet", "sheet-gid"].includes(value)) {
    return "gid";
  }
  return undefined;
};

const getByMode = (
  identifier: string,
  mode: LookupMode
): GoogleSheetsTable | undefined => {
  switch (mode) {
    case "config":
      return tablesByConfigKey.get(normalizeString(identifier));
    case "key":
      return tablesByKey.get(normalizeString(identifier));
    case "id":
      return tablesById.get(normalizeString(identifier));
    case "gid": {
      const direct = tablesByGid.get(identifier);
      if (direct) {
        return direct;
      }

      const parsed = Number.parseInt(identifier, 10);
      if (Number.isFinite(parsed)) {
        return tablesByGidNumber.get(parsed);
      }
      return undefined;
    }
    default:
      return undefined;
  }
};

export const listGoogleSheetsTables = (): GoogleSheetsTable[] => [...tables];

export const findGoogleSheetsTable = (
  identifier: string,
  by?: string
): GoogleSheetsTable | undefined => {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return undefined;
  }

  const explicitMode = resolveMode(by);
  if (explicitMode) {
    return getByMode(trimmed, explicitMode);
  }

  return (
    getByMode(trimmed, "config") ??
    getByMode(trimmed, "key") ??
    getByMode(trimmed, "id") ??
    getByMode(trimmed, "gid")
  );
};

export const getGoogleSheetsTableOrThrow = (
  identifier: string,
  by?: string
): GoogleSheetsTable => {
  const match = findGoogleSheetsTable(identifier, by);
  if (!match) {
    const descriptor = by ? `${identifier} (${by})` : identifier;
    throw new Error(`Google Sheets table "${descriptor}" not found.`);
  }
  return match;
};

export const getDefaultGoogleSheetsTable = (): GoogleSheetsTable | undefined =>
  tables[0];
