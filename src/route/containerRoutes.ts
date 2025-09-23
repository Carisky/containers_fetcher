import { Router } from "express";
import { ContainerController } from "../controller/containerController";
import {
  checkFirebirdConnection,
  fetchCmrSampleRows,
  fetchWysylkiByMrn,
} from "../service/firebirdStatusService";
import apiKeyAuth from "../middleware/apiKeyAuth";
import basicAuth from "../middleware/basicAuth";
import { parseXmlFieldsForWysylkaRow } from "../utils/wysylkaXml";
import { getRequestLogs } from "../utils/requestLogFile";

const router = Router();

router.post("/lookup-bct", apiKeyAuth, ContainerController.lookupBct);
router.post("/lookup", apiKeyAuth, ContainerController.lookup);

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
  const rawFileCode =
    typeof req.query.fileCode === "string" ? req.query.fileCode : "";
  const normalizedFileCode = rawFileCode.trim();

  if (!normalizedMrn) {
    res.status(400).json({
      status: "error",
      message: "Route parameter `mrn` must be a non-empty string.",
    });
    return;
  }

  try {
    const rows = await fetchWysylkiByMrn(normalizedMrn, {
      fileCode: normalizedFileCode || undefined,
    });
    const enrichedRows = rows.map((row) => ({
      ...row,
      ...parseXmlFieldsForWysylkaRow(row),
    }));

    res.json({
      mrn: normalizedMrn,
      fileCode: normalizedFileCode || undefined,
      count: enrichedRows.length,
      rows: enrichedRows,
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
