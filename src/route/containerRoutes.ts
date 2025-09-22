import { Router } from "express";
import { ContainerController } from "../controller/containerController";
import { checkFirebirdConnection, fetchCmrSampleRows, fetchWysylkiByMrn } from "../service/firebirdStatusService";
import basicAuth from "../middleware/basicAuth";
import { getRequestLogs } from "../utils/requestLogFile";

const router = Router();

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

router.get("/huzar/winsad/db/wysylki/mrn/:mrn", async (req, res) => {
  const rawMrn = typeof req.params.mrn === "string" ? req.params.mrn : "";
  const normalizedMrn = rawMrn.trim();

  if (!normalizedMrn) {
    res.status(400).json({
      status: "error",
      message: "Route parameter `mrn` must be a non-empty string.",
    });
    return;
  }

  try {
    const rows = await fetchWysylkiByMrn(normalizedMrn);
    res.json({ mrn: normalizedMrn, count: rows.length, rows });
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