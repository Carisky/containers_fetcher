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

const resolveLibraryPath = (): string | undefined => {
  if (process.env.FIREBIRD_LIBRARY_PATH) {
    return process.env.FIREBIRD_LIBRARY_PATH;
  }

  const projectRoot = path.resolve(__dirname, "..", "..");
  const relativeWinLibrary = path.join(projectRoot, "lib", "fbclient", "fbclient.dll");
  const relativeLinuxLibrary = path.join(projectRoot, "lib", "fbclient", "libfbclient.so");

  if (process.platform === "win32") {
    return relativeWinLibrary;
  }

  return relativeLinuxLibrary;
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getFirebirdConfig = (): FirebirdConfig => ({
  host: process.env.FIREBIRD_HOST ?? "",
  port: parseNumber(process.env.FIREBIRD_PORT, 1050),
  database: process.env.FIREBIRD_DATABASE ?? "",
  user: process.env.FIREBIRD_USER ?? "",
  password: process.env.FIREBIRD_PASSWORD ?? "",
  role: process.env.FIREBIRD_ROLE || undefined,
  pageSize: parseNumber(process.env.FIREBIRD_PAGE_SIZE, 8192),
  charset: process.env.FIREBIRD_CHARSET ?? "UTF8",
  wireCrypt: process.env.FIREBIRD_WIRE_CRYPT ?? "",
  authPlugins: process.env.FIREBIRD_AUTH_PLUGINS ?? "",
  pluginName: process.env.FIREBIRD_PLUGIN_NAME || undefined,
  libraryPath: resolveLibraryPath(),
});
