import { gunzipSync, inflateRawSync, inflateSync } from "zlib";
import { Blob as FirebirdBlob } from "node-firebird-driver";
import type { Attachment, Transaction } from "node-firebird-driver";

export type DecodedXmlResult = {
  decoded: string | null;
  byteLength: number | null;
};

export const readBlobAsBuffer = async (
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

export const decodeZlibBuffer = (buffer: Buffer | null, context: string): DecodedXmlResult => {
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

export const bufferToUtf8OrBase64 = (buffer: Buffer): string => {
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

  const cleanedUtf8 = utf8Value.replace(/\u0000+/g, "");
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
