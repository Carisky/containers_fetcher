import { Router } from "express";
import { ContainerController } from "../controller/containerController";
import { checkFirebirdConnection, fetchCmrSampleRows } from "../service/firebirdStatusService";
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

router.get("/utils/logs", basicAuth, async (_req, res, next) => {
  try {
    const logs = await getRequestLogs();
    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

export default router;