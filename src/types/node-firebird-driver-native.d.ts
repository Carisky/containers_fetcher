declare module "node-firebird-driver-native" {
  import type { Client } from "node-firebird-driver";

  export function createNativeClient(libraryFilename: string): Client;
  export function getDefaultLibraryFilename(): string;
}
