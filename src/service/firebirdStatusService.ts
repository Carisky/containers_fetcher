import { gunzipSync, inflateRawSync, inflateSync } from "zlib";
import { Blob as FirebirdBlob } from "node-firebird-driver";
import type {
  Attachment,
  Client,
  ConnectOptions,
  ResultSet,
  Transaction,
} from "node-firebird-driver";
import { getFirebirdConfig, FirebirdConfig } from "../config/firebirdConfig";

type NativeDriverModule = {
  createNativeClient: (library: string) => Client;
  getDefaultLibraryFilename: () => string;
};

type ConnectionContext = {
  client: Client;
  uri: string;
  options: ConnectOptions;
};

let cachedNativeModule: NativeDriverModule | null = null;
let nativeModuleError: Error | null = null;

const loadNativeDriver = (): NativeDriverModule => {
  if (cachedNativeModule) {
    return cachedNativeModule;
  }

  if (nativeModuleError) {
    throw nativeModuleError;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const moduleExports = require("node-firebird-driver-native") as NativeDriverModule;
    cachedNativeModule = moduleExports;
    return moduleExports;
  } catch (error) {
    const message =
      "Failed to load optional dependency 'node-firebird-driver-native'. " +
      "Install the Firebird client libraries and run `npm install node-firebird-driver-native` " +
      "(requires Visual Studio C++ build tools on Windows). Original error: " +
      (error instanceof Error ? error.message : String(error));

    nativeModuleError = new Error(message);
    throw nativeModuleError;
  }
};

const buildConnectionUri = (config: FirebirdConfig): string => {
  const host = config.host || "127.0.0.1";
  const port = config.port ?? 3050;
  const database = config.database;

  if (!database) {
    throw new Error("Firebird database path is not configured");
  }

  return `${host}/${port}:${database}`;
};

const buildConnectOptions = (config: FirebirdConfig): ConnectOptions => ({
  username: config.user,
  password: config.password,
  role: config.role,
});

const createConnectionContext = (config: FirebirdConfig): ConnectionContext => {
  const native = loadNativeDriver();
  const library = config.libraryPath || native.getDefaultLibraryFilename();

  return {
    client: native.createNativeClient(library),
    uri: buildConnectionUri(config),
    options: buildConnectOptions(config),
  };
};

const disconnectQuietly = async (attachment: Attachment | undefined | null) => {
  if (!attachment) {
    return;
  }

  try {
    if (attachment.isValid) {
      await attachment.disconnect();
    }
  } catch (error) {
    console.warn(
      `[firebird] Failed to disconnect attachment cleanly: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

const disposeQuietly = async (client: Client | undefined | null) => {
  if (!client) {
    return;
  }

  try {
    if (client.isValid) {
      await client.dispose();
    }
  } catch (error) {
    console.warn(
      `[firebird] Failed to dispose client cleanly: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

const closeResultSetQuietly = async (resultSet: ResultSet | undefined | null) => {
  if (!resultSet) {
    return;
  }

  try {
    if (resultSet.isValid) {
      await resultSet.close();
    }
  } catch (error) {
    console.warn(
      `[firebird] Failed to close result set cleanly: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

const rollbackQuietly = async (transaction: Transaction | undefined | null) => {
  if (!transaction) {
    return;
  }

  try {
    if (transaction && transaction.isValid) {
      await transaction.rollback();
    }
  } catch (error) {
    console.warn(
      `[firebird] Failed to rollback transaction cleanly: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

type RawWysylkaRow = {
  ID_WYSYLKI: unknown;
  TYPDOKUMENTUZRD: unknown;
  DOWEBCEL: unknown;
  OPERACJA: unknown;
  PRZETWORZONY: unknown;
  DATAUTWORZENIA: unknown;
  DATAROZPOPER: unknown;
  DATAWYSLANIA: unknown;
  TRESCBLEDU: unknown;
  STATUSTRANSMISJI: unknown;
  NAZWAPLIKU: unknown;
  DOKUMENTXML: unknown;
  ODPOWIEDZXML: unknown;
};

export type WysylkaSample = {
  idWysylki: number;
  typDokumentuZrd: string | null;
  dowebcel: string | null;
  operacja: string | null;
  przetworzony: number | null;
  dataUtworzenia: string | null;
  dataRozpoper: string | null;
  dataWyslania: string | null;
  trescBledu: string | null;
  statusTransmisji: string | null;
  nazwaPliku: string | null;
  dokumentXml: string | null;
  dokumentXmlBytes: number | null;
  odpowiedzXml: string | null;
  odpowiedzXmlBytes: number | null;
};

type DecodedXmlResult = {
  decoded: string | null;
  byteLength: number | null;
};

const readBlobAsBuffer = async (
  attachment: Attachment,
  transaction: Transaction,
  value: unknown
): Promise<Buffer | null> => {
  if (value === undefined || value === null) {
    return null;
  }

  if (Buffer.isBuffer(value)) {
    return value.length === 0 ? Buffer.alloc(0) : Buffer.from(value);
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  if (typeof value === "string" && value.length > 0) {
    return Buffer.from(value, "binary");
  }

  if (value instanceof FirebirdBlob) {
    if (!transaction || !transaction.isValid) {
      throw new Error("Cannot read Firebird blob: transaction is not active");
    }

    const stream = await attachment.openBlob(transaction, value);
    const chunks: Buffer[] = [];
    const reusable = Buffer.alloc(8192);

    try {
      for (;;) {
        const bytesRead = await stream.read(reusable);
        if (bytesRead === -1) {
          break;
        }

        if (bytesRead > 0) {
          chunks.push(Buffer.from(reusable.subarray(0, bytesRead)));
        }
      }
    } finally {
      await stream.close();
    }

    if (chunks.length === 0) {
      return Buffer.alloc(0);
    }

    return Buffer.concat(chunks);
  }

  return null;
};

const decodeZlibBuffer = (buffer: Buffer | null, context: string): DecodedXmlResult => {
  if (buffer === null) {
    return { decoded: null, byteLength: null };
  }

  if (buffer.length === 0) {
    return { decoded: "", byteLength: 0 };
  }

  const inflateCandidates = [inflateSync, inflateRawSync, gunzipSync] as const;
  let lastError: unknown = null;

  for (const inflate of inflateCandidates) {
    try {
      const output = inflate(buffer);
      return { decoded: output.toString("utf8"), byteLength: buffer.length };
    } catch (error) {
      lastError = error;
    }
  }

  const fallbackText = buffer.toString("utf8");
  if (fallbackText.length > 0) {
    return { decoded: fallbackText, byteLength: buffer.length };
  }

  const errorMessage = (
    lastError instanceof Error ? lastError.message : String(lastError)
  );

  throw new Error(
    `${context}: failed to decompress zlib payload (${buffer.length} bytes). Last error: ${errorMessage}`
  );
};

const bufferToUtf8OrBase64 = (buffer: Buffer): string => {
  if (buffer.length === 0) {
    return "";
  }

  const utf8Value = buffer.toString("utf8");
  const reencoded = Buffer.from(utf8Value, "utf8");
  if (reencoded.length === buffer.length && reencoded.equals(buffer)) {
    return utf8Value;
  }

  return buffer.toString("base64");
};

const normalizeColumnValue = async (
  key: string,
  value: unknown,
  attachment: Attachment,
  transaction: Transaction
): Promise<unknown> => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Buffer.isBuffer(value)) {
    return bufferToUtf8OrBase64(value);
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return bufferToUtf8OrBase64(
      Buffer.from(view.buffer, view.byteOffset, view.byteLength)
    );
  }

  if (value instanceof ArrayBuffer) {
    return bufferToUtf8OrBase64(Buffer.from(value));
  }

  if (value instanceof FirebirdBlob) {
    const blobBuffer = await readBlobAsBuffer(attachment, transaction, value);
    return blobBuffer ? bufferToUtf8OrBase64(blobBuffer) : null;
  }

  return value;
};

const toNullableText = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  return null;
};

const toNullableDateText = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
};

const toNullableNumeric = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
};

const mapRawWysylkaRow = async (
  row: RawWysylkaRow,
  attachment: Attachment,
  transaction: Transaction
): Promise<WysylkaSample> => {
  const id = Number(row.ID_WYSYLKI);
  if (!Number.isFinite(id)) {
    throw new Error(`Unexpected ID_WYSYLKI value: ${row.ID_WYSYLKI}`);
  }

  const dokumentBuffer = await readBlobAsBuffer(
    attachment,
    transaction,
    row.DOKUMENTXML
  );
  const dokument = decodeZlibBuffer(
    dokumentBuffer,
    `WYSYLKICELINA.ID_WYSYLKI=${id} DOKUMENTXML`
  );

  const odpowiedzBuffer = await readBlobAsBuffer(
    attachment,
    transaction,
    row.ODPOWIEDZXML
  );
  const odpowiedz = decodeZlibBuffer(
    odpowiedzBuffer,
    `WYSYLKICELINA.ID_WYSYLKI=${id} ODPOWIEDZXML`
  );

  return {
    idWysylki: id,
    typDokumentuZrd: toNullableText(row.TYPDOKUMENTUZRD),
    dowebcel: toNullableText(row.DOWEBCEL),
    operacja: toNullableText(row.OPERACJA),
    przetworzony: toNullableNumeric(row.PRZETWORZONY),
    dataUtworzenia: toNullableDateText(row.DATAUTWORZENIA),
    dataRozpoper: toNullableDateText(row.DATAROZPOPER),
    dataWyslania: toNullableDateText(row.DATAWYSLANIA),
    trescBledu: toNullableText(row.TRESCBLEDU),
    statusTransmisji: toNullableText(row.STATUSTRANSMISJI),
    nazwaPliku: toNullableText(row.NAZWAPLIKU),
    dokumentXml: dokument.decoded,
    dokumentXmlBytes: dokument.byteLength,
    odpowiedzXml: odpowiedz.decoded,
    odpowiedzXmlBytes: odpowiedz.byteLength,
  };
};

const mapWysylkaRowWithAllColumns = async (
  row: Record<string, unknown>,
  attachment: Attachment,
  transaction: Transaction
): Promise<Record<string, unknown>> => {
  const rawId = row["ID_WYSYLKI"];
  const numericId = typeof rawId === "number" ? rawId : Number(rawId);
  const contextId = Number.isFinite(numericId)
    ? numericId.toString()
    : String(rawId ?? "unknown");

  const dokumentBuffer = await readBlobAsBuffer(
    attachment,
    transaction,
    row["DOKUMENTXML"]
  );
  const dokument = decodeZlibBuffer(
    dokumentBuffer,
    `WYSYLKICELINA.ID_WYSYLKI=${contextId} DOKUMENTXML`
  );

  const odpowiedzBuffer = await readBlobAsBuffer(
    attachment,
    transaction,
    row["ODPOWIEDZXML"]
  );
  const odpowiedz = decodeZlibBuffer(
    odpowiedzBuffer,
    `WYSYLKICELINA.ID_WYSYLKI=${contextId} ODPOWIEDZXML`
  );

  const base: Record<string, unknown> = {};
  const entries = await Promise.all(
    Object.entries(row).map(async ([key, value]) => {
      if (key === "DOKUMENTXML" || key === "ODPOWIEDZXML") {
        return null;
      }

      const normalized = await normalizeColumnValue(key, value, attachment, transaction);
      return [key, normalized] as const;
    })
  );

  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    const [key, value] = entry;
    base[key] = value;
  }

  if (Number.isFinite(numericId)) {
    base.ID_WYSYLKI = numericId;
    base.idWysylki = numericId;
  } else if (Object.prototype.hasOwnProperty.call(row, "ID_WYSYLKI")) {
    base.idWysylki = row["ID_WYSYLKI"] ?? null;
  }

  base.dokumentXml = dokument.decoded;
  base.dokumentXmlBytes = dokument.byteLength;
  base.odpowiedzXml = odpowiedz.decoded;
  base.odpowiedzXmlBytes = odpowiedz.byteLength;

  return base;
};



export const fetchWysylkiSamples = async (limit = 5): Promise<WysylkaSample[]> => {
  const numericLimit = Number(limit);
  if (!Number.isInteger(numericLimit) || numericLimit <= 0) {
    throw new Error(`Invalid limit value: ${limit}`);
  }

  const effectiveLimit = Math.min(Math.max(numericLimit, 1), 50);
  const config = getFirebirdConfig();
  const { client, uri, options } = createConnectionContext(config);

  let attachment: Attachment | null = null;
  let transaction: Transaction | null = null;
  let resultSet: ResultSet | null = null;

  try {
    attachment = await client.connect(uri, options);
    transaction = await attachment.startTransaction();

    const sql = `
      SELECT FIRST ${effectiveLimit}
        r.ID_WYSYLKI,
        r.TYPDOKUMENTUZRD,
        r.DOWEBCEL,
        r.OPERACJA,
        r.PRZETWORZONY,
        r.DATAUTWORZENIA,
        r.DATAROZPOPER,
        r.DATAWYSLANIA,
        r.TRESCBLEDU,
        r.STATUSTRANSMISJI,
        r.NAZWAPLIKU,
        r.DOKUMENTXML,
        r.ODPOWIEDZXML
      FROM WYSYLKICELINA r
      ORDER BY r.ID_WYSYLKI DESC
    `;

    resultSet = await attachment.executeQuery(transaction, sql);
    const rows = await resultSet.fetchAsObject<RawWysylkaRow>();
    await resultSet.close();
    resultSet = null;

    const activeAttachment = attachment;
    const activeTransaction = transaction;

    if (!activeAttachment || !activeTransaction || !activeTransaction.isValid) {
      throw new Error("Firebird transaction ended unexpectedly while reading WYSYLKICELINA blobs");
    }

    const samples: WysylkaSample[] = [];
    for (const row of rows) {
      samples.push(await mapRawWysylkaRow(row, activeAttachment, activeTransaction));
    }

    if (activeTransaction.isValid) {
      await activeTransaction.commit();
    }
    transaction = null;

    return samples;
  } catch (error) {
    await rollbackQuietly(transaction);
    throw error;
  } finally {
    await closeResultSetQuietly(resultSet);
    await disconnectQuietly(attachment);
    await disposeQuietly(client);
  }

};


export const fetchWysylkiByMrn = async (
  mrn: string
): Promise<Record<string, unknown>[]> => {
  const normalizedMrn = typeof mrn === "string" ? mrn.trim() : "";
  if (!normalizedMrn) {
    throw new Error("MRN value must be a non-empty string");
  }

  const config = getFirebirdConfig();
  const { client, uri, options } = createConnectionContext(config);

  let attachment: Attachment | null = null;
  let transaction: Transaction | null = null;
  let resultSet: ResultSet | null = null;

  try {
    attachment = await client.connect(uri, options);
    transaction = await attachment.startTransaction();

    const sql = `
      SELECT
        r.*
      FROM WYSYLKICELINA r
      WHERE r.NRMRNDOK STARTING WITH ?
      ORDER BY r.ID_WYSYLKI DESC
    `;

    resultSet = await attachment.executeQuery(transaction, sql, [normalizedMrn]);
    const rows = await resultSet.fetchAsObject<Record<string, unknown>>();
    await resultSet.close();
    resultSet = null;

    if (!attachment || !transaction || !transaction.isValid) {
      throw new Error(
        "Firebird transaction ended unexpectedly while decoding WYSYLKICELINA rows"
      );
    }

    const decodedRows: Record<string, unknown>[] = [];
    for (const row of rows) {
      decodedRows.push(await mapWysylkaRowWithAllColumns(row, attachment, transaction));
    }

    if (transaction.isValid) {
      await transaction.commit();
    }
    transaction = null;

    return decodedRows;
  } catch (error) {
    await rollbackQuietly(transaction);
    throw error;
  } finally {
    await closeResultSetQuietly(resultSet);
    await disconnectQuietly(attachment);
    await disposeQuietly(client);
  }
};


export const checkFirebirdConnection = async (): Promise<void> => {
  const config = getFirebirdConfig();
  const { client, uri, options } = createConnectionContext(config);

  let attachment: Attachment | null = null;

  try {
    console.log(
      `[firebird] Checking connection to ${uri} with user ${options.username ?? "(default)"}`
    );

    attachment = await client.connect(uri, options);
  } finally {
    await disconnectQuietly(attachment);
    await disposeQuietly(client);
  }
};

export const fetchCmrSampleRows = async (): Promise<Record<string, unknown>[]> => {
  const config = getFirebirdConfig();
  const { client, uri, options } = createConnectionContext(config);

  let attachment: Attachment | null = null;
  let transaction: Transaction | null = null;
  let resultSet: ResultSet | null = null;

  try {
    attachment = await client.connect(uri, options);
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
    await rollbackQuietly(transaction);
    throw error;
  } finally {
    await closeResultSetQuietly(resultSet);
    await disconnectQuietly(attachment);
    await disposeQuietly(client);
  }
};
