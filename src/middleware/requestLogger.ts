import { RequestHandler } from "express";
import { appendRequestLog } from "../utils/requestLogFile";

type Jsonish =
  | Record<string, unknown>
  | Array<unknown>
  | string
  | number
  | boolean
  | null;

const cloneValue = (value: unknown): Jsonish | undefined => {
  if (value === null || value === undefined) {
    return value as null | undefined;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return "[unserializable]";
    }
  }

  return value as Jsonish;
};

const requestLogger: RequestHandler = (req, res, next) => {
  const startTime = process.hrtime.bigint();

  res.on("finish", () => {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000;
    const timestamp = new Date().toISOString();

    const headers: Record<string, string | string[] | undefined> = {};
    Object.entries(req.headers).forEach(([key, value]) => {
      headers[key] = value as string | string[] | undefined;
    });

    appendRequestLog({
      timestamp,
      method: req.method,
      url: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(3)),
      headers,
      query: cloneValue(req.query) as Record<string, unknown>,
      body: cloneValue(req.body),
      ip: req.ip,
    }).catch((error) => {
      console.error("Failed to write request log", error);
    });

    console.log(
      `[${timestamp}] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} (${durationMs.toFixed(3)} ms)`
    );
  });

  next();
};

export default requestLogger;
