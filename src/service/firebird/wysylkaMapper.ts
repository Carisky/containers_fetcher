import { Blob as FirebirdBlob } from "node-firebird-driver";
import type { Attachment, Transaction } from "node-firebird-driver";
import {
  bufferToUtf8OrBase64,
  decodeZlibBuffer,
  readBlobAsBuffer,
  type DecodedXmlResult,
} from "./xmlDecoders";

type MapOptions = {
  includeDocumentXml?: boolean;
  includeResponseXml?: boolean;
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

export const mapWysylkaRowWithAllColumns = async (
  row: Record<string, unknown>,
  attachment: Attachment,
  transaction: Transaction,
  options: MapOptions = {}
): Promise<Record<string, unknown>> => {
  const includeDocumentXml = options.includeDocumentXml ?? true;
  const includeResponseXml = options.includeResponseXml ?? true;

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

  let odpowiedz: DecodedXmlResult = { decoded: null, byteLength: null };
  if (includeResponseXml) {
    const odpowiedzBuffer = await readBlobAsBuffer(
      attachment,
      transaction,
      row["ODPOWIEDZXML"]
    );
    odpowiedz = decodeZlibBuffer(
      odpowiedzBuffer,
      `WYSYLKICELINA.ID_WYSYLKI=${contextId} ODPOWIEDZXML`
    );
  }

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
