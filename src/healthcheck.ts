import "./config/environment";

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (typeof raw !== "string") {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
};

const port = Number.parseInt(process.env.PORT || "3400", 10);
const defaultUrl = `http://127.0.0.1:${port}/healthcheck`;
const url = (process.env.HEALTHCHECK_URL || defaultUrl).trim();
const timeoutMs = parsePositiveInt(process.env.HEALTHCHECK_TIMEOUT_MS, 5_000);

const run = async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status !== 200) {
      console.error(`Healthcheck failed: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Healthcheck failed: ${message}`);
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
};

run();

