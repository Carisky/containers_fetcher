import { Router } from "express";
import { ContainerController } from "../controller/containerController";
import { checkFirebirdConnection, fetchCmrSampleRows, fetchWysylkiSamples } from "../service/firebirdStatusService";
import basicAuth from "../middleware/basicAuth";
import { getRequestLogs } from "../utils/requestLogFile";

const router = Router();

const DEFAULT_WYSYLKI_LIMIT = 5;
const MAX_WYSYLKI_LIMIT = 50;

const parsePositiveInteger = (
  value: unknown
): number | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return null;
    }

    return parsePositiveInteger(value[0]);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return null;
    }

    return parsed;
  }

  return null;
};

router.post("/lookup-bct", ContainerController.lookupBct);
router.post("/lookup", ContainerController.lookup);

router.get("/huzar/winsad/db/status", async (_req, res) => {
  try {
    await checkFirebirdConnection();
    res.json({ status: "ok" });
  } catch (error) {
    res.status(503).json({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get("/huzar/winsad/db/test", async (_req, res) => {
  try {
    const rows = await fetchCmrSampleRows();
    res.json({ rows });
  } catch (error) {
    res.status(503).json({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get("/huzar/winsad/db/wysylki/sample", async (req, res) => {
  const parsedLimit = parsePositiveInteger(req.query.limit);

  if (req.query.limit !== undefined && parsedLimit === null) {
    res.status(400).json({
      status: "error",
      message: "Query parameter `limit` must be a positive integer.",
    });
    return;
  }

  const requestedLimit = parsedLimit ?? DEFAULT_WYSYLKI_LIMIT;
  const effectiveLimit = Math.min(requestedLimit, MAX_WYSYLKI_LIMIT);
  const isCapped = requestedLimit > MAX_WYSYLKI_LIMIT;

  try {
    const rows = await fetchWysylkiSamples(effectiveLimit);
    res.json({
      limit: effectiveLimit,
      rows,
      ...(isCapped ? { requestedLimit } : {}),
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get("/utils/logs", basicAuth, async (_req, res, next) => {
  try {
    const logs = await getRequestLogs();
    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

export default router;