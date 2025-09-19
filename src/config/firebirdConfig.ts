import path from "path";

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

export const getFirebirdConfig = (): FirebirdConfig => ({
  host: "192.168.1.165",
  port: 3050,
  database: "D:/DaneIB/SADDANEIB.FDB",
  user: "sysdba",
  password: "Cezar1",
  charset: "UTF8",
  pageSize: 8192,
  wireCrypt: "Required",
  authPlugins: "Srp",
  libraryPath: resolveLibraryPath(),
});

