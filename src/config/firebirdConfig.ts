import path from "path";
import "./environment";

export type FirebirdConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  role?: string;
  pageSize?: number;
  charset?: string;
  wireCrypt?: string;
  authPlugins?: string;
  pluginName?: string;
  libraryPath?: string;
};

const getOptionalEnv = (key: string): string | undefined => {
  const value = process.env[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const getStringEnv = (key: string, fallback: string): string => {
  const value = getOptionalEnv(key);
  return value ?? fallback;
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveLibraryPath = (): string | undefined => {
  const configured = getOptionalEnv("FIREBIRD_LIBRARY_PATH");
  if (configured) {
    return configured;
  }

  const projectRoot = path.resolve(__dirname, "..", "..");
  const relativeWinLibrary = path.join(projectRoot, "lib", "fbclient", "fbclient.dll");
  const relativeLinuxLibrary = path.join(projectRoot, "lib", "fbclient", "libfbclient.so");

  if (process.platform === "win32") {
    return relativeWinLibrary;
  }

  return relativeLinuxLibrary;
};

export const getFirebirdConfig = (): FirebirdConfig => ({
  host: getStringEnv("FIREBIRD_HOST", "127.0.0.1"),
  port: parseNumber(getOptionalEnv("FIREBIRD_PORT"), 3050),
  database: getStringEnv("FIREBIRD_DATABASE", "D:/DaneIB/SADDANEIB.FDB"),
  user: getStringEnv("FIREBIRD_USER", "sysdba"),
  password: getStringEnv("FIREBIRD_PASSWORD", "masterkey"),
  role: getOptionalEnv("FIREBIRD_ROLE"),
  pageSize: parseNumber(getOptionalEnv("FIREBIRD_PAGE_SIZE"), 8192),
  charset: getStringEnv("FIREBIRD_CHARSET", "UTF8"),
  wireCrypt: getStringEnv("FIREBIRD_WIRE_CRYPT", "Required"),
  authPlugins: getStringEnv("FIREBIRD_AUTH_PLUGINS", "Srp"),
  pluginName: getOptionalEnv("FIREBIRD_PLUGIN_NAME"),
  libraryPath: resolveLibraryPath(),
});