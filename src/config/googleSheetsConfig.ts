import fs from "fs";
import path from "path";
import type { JWTInput } from "google-auth-library";
import { getDefaultGoogleSheetsTable } from "./googleSheetsTables";

const ROOT_DIR = process.cwd();
const DEFAULT_CREDENTIALS_FILE = path.join(ROOT_DIR, "credentials.json");

export const GOOGLE_SHEETS_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
];

type JsonObject = Record<string, unknown>;

export type GoogleSheetsAuthMode =
  | { mode: "service-account"; credentials: JWTInput }
  | { mode: "service-account-file"; keyFile: string }
  | {
      mode: "oauth";
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    };

const toJsonObject = (value: unknown): JsonObject | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return null;
};

const decodeInlineJson = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Inline Google Sheets credentials are empty.");
  }

  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (!decoded.trim().startsWith("{")) {
      throw new Error("Decoded value does not look like JSON.");
    }
    return decoded;
  } catch (error) {
    throw new Error(
      `Failed to decode GOOGLE_SHEETS_CREDENTIALS_JSON: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
};

interface CredentialsSource {
  json: JsonObject;
  filePath?: string;
}

const readJsonFile = (candidatePath: string): CredentialsSource => {
  const resolved = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.join(ROOT_DIR, candidatePath);

  const contents = fs.readFileSync(resolved, "utf8");
  try {
    const parsed = JSON.parse(contents);
    const json = toJsonObject(parsed);
    if (!json) {
      throw new Error("JSON root must be an object.");
    }
    return { json, filePath: resolved };
  } catch (error) {
    throw new Error(
      `Failed to parse Google Sheets credentials file "${resolved}": ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
};

const loadCredentialsSource = (): CredentialsSource | null => {
  const inline = process.env.GOOGLE_SHEETS_CREDENTIALS_JSON;
  if (inline && inline.trim().length > 0) {
    const decoded = decodeInlineJson(inline);
    try {
      const parsed = JSON.parse(decoded);
      const json = toJsonObject(parsed);
      if (!json) {
        throw new Error("JSON root must be an object.");
      }
      return { json };
    } catch (error) {
      throw new Error(
        `GOOGLE_SHEETS_CREDENTIALS_JSON contains invalid JSON: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  const pathFromEnv = process.env.GOOGLE_SHEETS_CREDENTIALS_PATH;
  if (pathFromEnv && pathFromEnv.trim().length > 0) {
    return readJsonFile(pathFromEnv.trim());
  }

  if (fs.existsSync(DEFAULT_CREDENTIALS_FILE)) {
    return readJsonFile(DEFAULT_CREDENTIALS_FILE);
  }

  return null;
};

const normalizePrivateKey = (key: string): string =>
  key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;

const extractServiceAccount = (
  source: CredentialsSource | null,
): GoogleSheetsAuthMode | null => {
  if (!source) {
    return null;
  }

  const root = source.json;
  const type = String(root["type"] ?? "");
  const hasPrivateKey =
    typeof root["private_key"] === "string" &&
    typeof root["client_email"] === "string";

  if (type === "service_account" || hasPrivateKey) {
    if (source.filePath) {
      return { mode: "service-account-file", keyFile: source.filePath };
    }

    const credentials: JWTInput = {
      type: "service_account",
      ...(root as JWTInput),
    };
    if (typeof credentials.private_key === "string") {
      credentials.private_key = normalizePrivateKey(credentials.private_key);
    }
    return { mode: "service-account", credentials };
  }

  return null;
};

const extractOAuthFromJson = (
  source: CredentialsSource | null,
): { clientId: string; clientSecret: string } | null => {
  if (!source) {
    return null;
  }

  const installed = toJsonObject(source.json["installed"]);
  const web = toJsonObject(source.json["web"]);
  const candidate = installed ?? web;
  if (!candidate) {
    return null;
  }

  const clientId = candidate["client_id"];
  const clientSecret = candidate["client_secret"];

  if (typeof clientId === "string" && typeof clientSecret === "string") {
    return {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    };
  }

  return null;
};

const getOAuthRefreshToken = (): string | null => {
  const token =
    process.env.GOOGLE_SHEETS_REFRESH_TOKEN ??
    process.env.GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN;
  if (!token) {
    return null;
  }

  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getOAuthFromEnv = ():
  | {
      clientId: string;
      clientSecret: string;
    }
  | null => {
  const clientId =
    process.env.GOOGLE_SHEETS_OAUTH_CLIENT_ID ??
    process.env.GOOGLE_SHEETS_CLIENT_ID;
  const clientSecret =
    process.env.GOOGLE_SHEETS_OAUTH_CLIENT_SECRET ??
    process.env.GOOGLE_SHEETS_CLIENT_SECRET;

  const normalizedClientId = clientId?.trim();
  const normalizedClientSecret = clientSecret?.trim();

  if (!normalizedClientId || !normalizedClientSecret) {
    return null;
  }

  return {
    clientId: normalizedClientId,
    clientSecret: normalizedClientSecret,
  };
};

const getServiceAccountFromEnv = (): GoogleSheetsAuthMode | null => {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    return null;
  }

  const projectId = process.env.GOOGLE_SHEETS_PROJECT_ID?.trim();
  const credentials: JWTInput = {
    type: "service_account",
    client_email: clientEmail,
    private_key: normalizePrivateKey(privateKey),
    project_id: projectId,
  };

  return { mode: "service-account", credentials };
};

export const getGoogleSheetsAuthMode = (): GoogleSheetsAuthMode => {
  const envServiceAccount = getServiceAccountFromEnv();
  if (envServiceAccount) {
    return envServiceAccount;
  }

  const envOAuth = getOAuthFromEnv();
  if (envOAuth) {
    const refreshToken = getOAuthRefreshToken();
    if (!refreshToken) {
      throw new Error(
        "GOOGLE_SHEETS_REFRESH_TOKEN is required when using OAuth credentials.",
      );
    }

    return {
      mode: "oauth",
      clientId: envOAuth.clientId,
      clientSecret: envOAuth.clientSecret,
      refreshToken,
    };
  }

  const source = loadCredentialsSource();
  const serviceAccount = extractServiceAccount(source);
  if (serviceAccount) {
    return serviceAccount;
  }

  const oauthBase = extractOAuthFromJson(source);
  if (oauthBase) {
    const refreshToken = getOAuthRefreshToken();
    if (!refreshToken) {
      throw new Error(
        "GOOGLE_SHEETS_REFRESH_TOKEN is required when using OAuth credentials.",
      );
    }

    return {
      mode: "oauth",
      clientId: oauthBase.clientId,
      clientSecret: oauthBase.clientSecret,
      refreshToken,
    };
  }

  throw new Error(
    "Google Sheets credentials are not configured. Provide a service account key (JSON or env vars) or OAuth client credentials plus GOOGLE_SHEETS_REFRESH_TOKEN.",
  );
};

const DEFAULT_TEST_SPREADSHEET_ID =
  "1rqouhd9J_VDkOSClLL-P54zT602IJSlmGX2YOAXAgPE";
const DEFAULT_TEST_SHEET_GID = 1723757569;
const DEFAULT_TEST_HEADER = "Numer T1 / T2 MRN";

const parseSheetId = (raw: string | undefined): number | undefined => {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export interface TestSpreadsheetConfig {
  spreadsheetId: string;
  sheetId?: number;
  sheetName?: string;
  headerName: string;
}

export const getTestSpreadsheetConfig = (): TestSpreadsheetConfig => {
  const defaultTable = getDefaultGoogleSheetsTable();
  const envSpreadsheetId =
    process.env.GOOGLE_SHEETS_TEST_SPREADSHEET_ID?.trim();
  const spreadsheetId =
    (envSpreadsheetId && envSpreadsheetId.length > 0
      ? envSpreadsheetId
      : undefined) ||
    defaultTable?.id ||
    DEFAULT_TEST_SPREADSHEET_ID;
  const sheetName =
    process.env.GOOGLE_SHEETS_TEST_SHEET_NAME?.trim() ||
    defaultTable?.sheetName ||
    undefined;
  const sheetId =
    parseSheetId(process.env.GOOGLE_SHEETS_TEST_SHEET_GID) ??
    defaultTable?.gidNumber ??
    DEFAULT_TEST_SHEET_GID;
  const headerName =
    process.env.GOOGLE_SHEETS_TEST_HEADER?.trim() ||
    defaultTable?.key ||
    DEFAULT_TEST_HEADER;

  return {
    spreadsheetId,
    sheetId,
    sheetName,
    headerName,
  };
};
