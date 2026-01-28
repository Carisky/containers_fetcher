import { Router } from "express";
import { checkFirebirdConnection } from "../service/firebird";
import { getFirstQueryParam } from "./helpers/queryParams";

const healthcheckRoutes = Router();

const parseEnabledFlag = (raw: string, defaultValue: boolean): boolean => {
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

healthcheckRoutes.get("/healthcheck", async (req, res) => {
  const checkedAt = new Date().toISOString();
  const deep =
    Object.prototype.hasOwnProperty.call(req.query ?? {}, "deep") === false
      ? true
      : parseEnabledFlag(getFirstQueryParam(req.query.deep), true);

  const firebirdEnabled = parseEnabledFlag(process.env.HEALTHCHECK_FIREBIRD ?? "true", true);

  const checks: Record<
    string,
    { status: "ok" | "error"; durationMs?: number; message?: string }
  > = {};

  if (deep && firebirdEnabled) {
    const start = Date.now();
    try {
      await checkFirebirdConnection();
      checks.firebird = { status: "ok", durationMs: Date.now() - start };
    } catch (error) {
      checks.firebird = {
        status: "error",
        durationMs: Date.now() - start,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  const ok = Object.values(checks).every((check) => check.status === "ok");

  res.status(ok ? 200 : 500).json({
    status: ok ? "ok" : "error",
    checkedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    deep,
    checks,
  });
});

export default healthcheckRoutes;

