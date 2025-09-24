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


const DEFAULT_FIREBIRD_POOL_SIZE = Math.max(
  1,
  Number.parseInt(process.env.FIREBIRD_POOL_SIZE ?? "4", 10)
);

type AttachmentLease = {
  client: Client;
  attachment: Attachment;
};

class FirebirdAttachmentPool {
  private readonly maxSize: number;
  private available: AttachmentLease[] = [];
  private pending: Array<(lease: AttachmentLease) => void> = [];
  private total = 0;
  private closed = false;

  constructor(maxSize: number) {
    this.maxSize = Math.max(1, maxSize);
  }

  async acquire(): Promise<AttachmentLease> {
    if (this.closed) {
      throw new Error("Firebird attachment pool is closed");
    }

    for (;;) {
      const lease = this.available.pop();
      if (!lease) {
        break;
      }

      if (this.isLeaseValid(lease)) {
        return lease;
      }

      await this.destroyLease(lease);
    }

    if (this.total < this.maxSize) {
      const lease = await this.createLease();
      this.total += 1;
      return lease;
    }

    return new Promise<AttachmentLease>((resolve) => {
      this.pending.push(resolve);
    });
  }

  async release(lease: AttachmentLease, recycle = true): Promise<void> {
    if (this.closed || !recycle || !this.isLeaseValid(lease)) {
      await this.destroyLease(lease);
      return;
    }

    const resolver = this.pending.shift();
    if (resolver) {
      resolver(lease);
      return;
    }

    this.available.push(lease);
  }

  async destroyAll(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const tasks = this.available.map((lease) => this.destroyLease(lease));
    this.available = [];
    await Promise.allSettled(tasks);
  }

  private isLeaseValid(lease: AttachmentLease): boolean {
    return Boolean(lease.attachment?.isValid && lease.client?.isValid);
  }

  private async createLease(): Promise<AttachmentLease> {
    const config = getFirebirdConfig();
    const { client, uri, options } = createConnectionContext(config);
    const attachment = await client.connect(uri, options);
    return { client, attachment };
  }

  private async destroyLease(lease: AttachmentLease): Promise<void> {
    await disconnectQuietly(lease.attachment);
    await disposeQuietly(lease.client);
    if (this.total > 0) {
      this.total -= 1;
    }
  }
}

const firebirdAttachmentPool = new FirebirdAttachmentPool(DEFAULT_FIREBIRD_POOL_SIZE);

const shutdownFirebirdPool = async () => {
  await firebirdAttachmentPool.destroyAll().catch((error) => {
    console.warn(
      `[firebird] Failed to shut down attachment pool: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
};

process.once("SIGINT", () => {
  void shutdownFirebirdPool();
});
process.once("SIGTERM", () => {
  void shutdownFirebirdPool();
});

const withFirebirdAttachment = async <T>(
  handler: (lease: AttachmentLease) => Promise<T>
): Promise<T> => {
  const lease = await firebirdAttachmentPool.acquire();
  let recycle = true;

  try {
    const result = await handler(lease);
    recycle = recycle && lease.attachment.isValid && lease.client.isValid;
    return result;
  } catch (error) {
    recycle = lease.attachment.isValid && lease.client.isValid;
    throw error;
  } finally {
    const finalRecycle = recycle && lease.attachment.isValid && lease.client.isValid;
    await firebirdAttachmentPool.release(lease, finalRecycle);
  }
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
      return { decoded: bufferToUtf8OrBase64(output), byteLength: output.length };
    } catch (error) {
      lastError = error;
    }
  }

  const fallbackText = bufferToUtf8OrBase64(buffer);
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

  const hasUtf16LeBom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  if (hasUtf16LeBom) {
    return buffer.slice(2).toString("utf16le");
  }

  const hasUtf16BeBom = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff;
  if (hasUtf16BeBom) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let i = 2; i < buffer.length; i += 2) {
      const high = buffer[i];
      const low = i + 1 < buffer.length ? buffer[i + 1] : 0;
      swapped[i - 2] = low;
      swapped[i - 1] = high;
    }
    return swapped.toString("utf16le");
  }

  let zeroCount = 0;
  let evenZeroCount = 0;
  let oddZeroCount = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      zeroCount += 1;
      if (i % 2 === 0) {
        evenZeroCount += 1;
      } else {
        oddZeroCount += 1;
      }
    }
  }

  if (zeroCount > 0) {
    const zeroRatio = zeroCount / buffer.length;
    if (zeroRatio >= 0.2) {
      if (oddZeroCount >= evenZeroCount) {
        return buffer.toString("utf16le");
      }

      const swappedNoBom = Buffer.allocUnsafe(buffer.length);
      for (let i = 0; i < buffer.length; i += 2) {
        const high = buffer[i];
        const low = i + 1 < buffer.length ? buffer[i + 1] : 0;
        swappedNoBom[i] = low;
        if (i + 1 < buffer.length) {
          swappedNoBom[i + 1] = high;
        }
      }
      return swappedNoBom.toString("utf16le");
    }
  }

  const utf8Value = buffer.toString("utf8");
  const reencoded = Buffer.from(utf8Value, "utf8");
  if (reencoded.length === buffer.length && reencoded.equals(buffer)) {
    return utf8Value;
  }

  const cleanedUtf8 = utf8Value.replace(/ +/g, "");
  if (cleanedUtf8.includes("<")) {
    const xmlStart = cleanedUtf8.indexOf("<?xml");
    if (xmlStart >= 0) {
      return cleanedUtf8.slice(xmlStart);
    }

    const firstTagIndex = cleanedUtf8.indexOf("<");
    return firstTagIndex >= 0 ? cleanedUtf8.slice(firstTagIndex) : cleanedUtf8;
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

const mapWysylkaRowWithAllColumns = async (
  row: Record<string, unknown>,
  attachment: Attachment,
  transaction: Transaction,
  options: { includeDocumentXml?: boolean } = {}
): Promise<Record<string, unknown>> => {
  const includeDocumentXml = options.includeDocumentXml ?? true;

  const rawId = row["ID_WYSYLKI"];
  const numericId = typeof rawId === "number" ? rawId : Number(rawId);
  const contextId = Number.isFinite(numericId)
    ? numericId.toString()
    : String(rawId ?? "unknown");

  let dokument: DecodedXmlResult = { decoded: null, byteLength: null };
  if (includeDocumentXml) {
    const dokumentBuffer = await readBlobAsBuffer(
      attachment,
      transaction,
      row["DOKUMENTXML"]
    );
    dokument = decodeZlibBuffer(
      dokumentBuffer,
      `WYSYLKICELINA.ID_WYSYLKI=${contextId} DOKUMENTXML`
    );
  }

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



type FetchWysylkiByMrnOptions = {
  fileCode?: string;
  limit?: number;
  preferXml?: boolean;
  includeDocumentXml?: boolean;
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
    filterOptions.includeDocumentXml ?? true;

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

  return withFirebirdAttachment(async ({ attachment }) => {
    let transaction: Transaction | null = null;
    let resultSet: ResultSet | null = null;

    try {
      transaction = await attachment.startTransaction();

      const whereClause = conditions.join("\n        AND ");
      const sql = `
      SELECT FIRST ${limit}
        r.*
      FROM WYSYLKICELINA r
      WHERE ${whereClause}
      ORDER BY r.ID_WYSYLKI DESC
    `;

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
          })
        );
      }

      if (transaction.isValid) {
        await transaction.commit();
        transaction = null;
      }

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


