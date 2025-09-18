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
  libraryPath: "C:/Program Files/Firebird/Firebird_3_0/fbclient.dll"
});
