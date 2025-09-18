import { promises as fs } from "fs";
import path from "path";

export type RequestLogEntry = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: unknown;
  ip?: string;
};

const MAX_LOGS = 100;
const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "requests.json");

const ensureLogDir = async () => {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
  } catch (error) {
    // ignore mkdir errors (handled later)
  }
};

const readFileSafely = async (): Promise<RequestLogEntry[]> => {
  try {
    const data = await fs.readFile(LOG_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return parsed as RequestLogEntry[];
    }
    return [];
  } catch (error) {
    return [];
  }
};

export const appendRequestLog = async (
  entry: Omit<RequestLogEntry, "id">
): Promise<RequestLogEntry> => {
  await ensureLogDir();
  const existing = await readFileSafely();

  const record: RequestLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...entry,
  };

  const updated = [record, ...existing].slice(0, MAX_LOGS);
  await fs.writeFile(LOG_FILE, JSON.stringify(updated, null, 2), "utf-8");
  return record;
};

export const getRequestLogs = async (): Promise<RequestLogEntry[]> => {
  await ensureLogDir();
  return readFileSafely();
};
