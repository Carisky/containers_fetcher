type WatchdogOptions = {
  port: number;
};

const parseEnabledFlag = (raw: string | undefined, defaultValue: boolean): boolean => {
  if (typeof raw !== "string") {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  return defaultValue;
};

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

export const startHealthcheckWatchdog = ({ port }: WatchdogOptions) => {
  const enabled = parseEnabledFlag(process.env.HEALTHCHECK_WATCHDOG_ENABLED, false);
  if (!enabled) {
    return;
  }

  const defaultUrl = `http://127.0.0.1:${port}/healthcheck`;
  const url = (process.env.HEALTHCHECK_WATCHDOG_URL || defaultUrl).trim();
  const intervalMs = parsePositiveInt(process.env.HEALTHCHECK_WATCHDOG_INTERVAL_MS, 30_000);
  const timeoutMs = parsePositiveInt(process.env.HEALTHCHECK_WATCHDOG_TIMEOUT_MS, 5_000);
  const maxFailures = parsePositiveInt(process.env.HEALTHCHECK_WATCHDOG_MAX_FAILURES, 3);
  const startDelayMs = parsePositiveInt(process.env.HEALTHCHECK_WATCHDOG_START_DELAY_MS, 30_000);

  let consecutiveFailures = 0;
  let running = false;

  const checkOnce = async () => {
    if (running) {
      return;
    }

    running = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status >= 500) {
        consecutiveFailures += 1;
        console.error(
          `Healthcheck watchdog: got ${res.status} (${consecutiveFailures}/${maxFailures})`
        );
      } else {
        consecutiveFailures = 0;
      }
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Healthcheck watchdog: error "${message}" (${consecutiveFailures}/${maxFailures})`
      );
    } finally {
      clearTimeout(timeout);
      running = false;
    }

    if (consecutiveFailures >= maxFailures) {
      console.error("Healthcheck watchdog: exiting process to trigger container restart.");
      process.exit(1);
    }
  };

  setTimeout(() => {
    void checkOnce();
    setInterval(() => void checkOnce(), intervalMs);
  }, startDelayMs);
};

