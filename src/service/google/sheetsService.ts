import { google, sheets_v4 } from "googleapis";
import {
  GOOGLE_SHEETS_SCOPES,
  getGoogleSheetsAuthMode,
  getTestSpreadsheetConfig,
} from "../../config/googleSheetsConfig";

let sheetsClientPromise: Promise<sheets_v4.Sheets> | null = null;

const createSheetsClient = async (): Promise<sheets_v4.Sheets> => {
  const authMode = getGoogleSheetsAuthMode();

  if (authMode.mode === "service-account") {
    const auth = new google.auth.GoogleAuth({
      scopes: GOOGLE_SHEETS_SCOPES,
      credentials: authMode.credentials,
    });
    await auth.getClient();
    return google.sheets({ version: "v4", auth });
  }

  if (authMode.mode === "service-account-file") {
    const auth = new google.auth.GoogleAuth({
      scopes: GOOGLE_SHEETS_SCOPES,
      keyFile: authMode.keyFile,
    });
    await auth.getClient();
    return google.sheets({ version: "v4", auth });
  }

  const oauthClient = new google.auth.OAuth2(
    authMode.clientId,
    authMode.clientSecret,
  );
  oauthClient.setCredentials({ refresh_token: authMode.refreshToken });
  await oauthClient.getAccessToken();

  return google.sheets({ version: "v4", auth: oauthClient });
};

const getSheetsClient = async (): Promise<sheets_v4.Sheets> => {
  if (!sheetsClientPromise) {
    sheetsClientPromise = createSheetsClient();
  }
  return sheetsClientPromise;
};

const escapeSheetName = (name: string): string => name.replace(/'/g, "''");

const normalizeCellValue = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
};

export interface ColumnFetchParams {
  spreadsheetId: string;
  headerName: string;
  sheetName?: string;
  sheetId?: number;
}

export interface ColumnFetchResult {
  spreadsheetId: string;
  sheetName: string;
  header: string;
  values: string[];
}

const resolveSheetName = async (
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  preferences: { sheetName?: string; sheetId?: number },
): Promise<string> => {
  if (preferences.sheetName) {
    return preferences.sheetName;
  }

  if (preferences.sheetId === undefined) {
    throw new Error(
      "Unable to determine target sheet: sheet name or sheet gid must be provided.",
    );
  }

  const metadata = await sheets.spreadsheets.get({ spreadsheetId });
  const entry = metadata.data.sheets?.find(
    (sheet) => sheet.properties?.sheetId === preferences.sheetId,
  );

  const title = entry?.properties?.title;
  if (!title) {
    throw new Error(
      `Sheet with gid ${preferences.sheetId} not found in spreadsheet ${spreadsheetId}.`,
    );
  }

  return title;
};

export const fetchColumnByHeader = async (
  params: ColumnFetchParams,
): Promise<ColumnFetchResult> => {
  const sheets = await getSheetsClient();
  const sheetName = await resolveSheetName(sheets, params.spreadsheetId, {
    sheetId: params.sheetId,
    sheetName: params.sheetName,
  });

  const range = `'${escapeSheetName(sheetName)}'!A1:ZZ`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: params.spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    majorDimension: "ROWS",
  });

  const rows = response.data.values ?? [];
  if (rows.length === 0) {
    return {
      spreadsheetId: params.spreadsheetId,
      sheetName,
      header: params.headerName,
      values: [],
    };
  }

  const headers = rows[0] ?? [];
  const targetIndex = headers.findIndex((header) => {
    if (typeof header !== "string") {
      return false;
    }
    return header.trim().toLowerCase() === params.headerName.trim().toLowerCase();
  });

  if (targetIndex === -1) {
    throw new Error(
      `Column "${params.headerName}" not found in sheet "${sheetName}".`,
    );
  }

  const values: string[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rawValue = row?.[targetIndex];
    const normalized = normalizeCellValue(rawValue);
    if (normalized !== null) {
      values.push(normalized);
    }
  }

  return {
    spreadsheetId: params.spreadsheetId,
    sheetName,
    header: params.headerName,
    values,
  };
};

export const fetchTestColumn = async (): Promise<ColumnFetchResult> => {
  const config = getTestSpreadsheetConfig();
  return fetchColumnByHeader({
    spreadsheetId: config.spreadsheetId,
    sheetId: config.sheetId,
    sheetName: config.sheetName,
    headerName: config.headerName,
  });
};
