import type {
  Attachment,
  Client,
  ConnectOptions,
  ResultSet,
  Transaction,
} from "node-firebird-driver";
import { getFirebirdConfig, FirebirdConfig } from "../../config/firebirdConfig";

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

export const buildConnectionUri = (config: FirebirdConfig): string => {
  const host = config.host || "127.0.0.1";
  const port = config.port ?? 3050;
  const database = config.database;

  if (!database) {
    throw new Error("Firebird database path is not configured");
  }

  return `${host}/${port}:${database}`;
};

export const buildConnectOptions = (config: FirebirdConfig): ConnectOptions => ({
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

export const withFirebirdAttachment = async <T>(
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

export const disconnectQuietly = async (
  attachment: Attachment | undefined | null
): Promise<void> => {
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

export const disposeQuietly = async (client: Client | undefined | null): Promise<void> => {
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

export const closeResultSetQuietly = async (
  resultSet: ResultSet | undefined | null
): Promise<void> => {
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

export const rollbackQuietly = async (
  transaction: Transaction | undefined | null
): Promise<void> => {
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
