import type { Attachment, Client, ConnectOptions } from "node-firebird-driver";
import { getFirebirdConfig, FirebirdConfig } from "../config/firebirdConfig";

type NativeDriverModule = {
  createNativeClient: (library: string) => Client;
  getDefaultLibraryFilename: () => string;
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

export const checkFirebirdConnection = async (): Promise<void> => {
  const config = getFirebirdConfig();
  const native = loadNativeDriver();
  const library = config.libraryPath || native.getDefaultLibraryFilename();

  const client = native.createNativeClient(library);
  let attachment: Attachment | null = null;

  try {
    const uri = buildConnectionUri(config);
    const options = buildConnectOptions(config);

    console.log(
      `[firebird] Checking connection to ${uri} with user ${options.username ?? "(default)"}`
    );

    attachment = await client.connect(uri, options);
  } finally {
    await disconnectQuietly(attachment);
    await disposeQuietly(client);
  }
};
