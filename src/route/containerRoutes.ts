import { Router } from "express";
import { ContainerController } from "../controller/containerController";
import basicAuth from "../middleware/basicAuth";
import { getRequestLogs } from "../utils/requestLogFile";

const router = Router();

router.post("/lookup-bct", ContainerController.lookupBct);
router.post("/lookup", ContainerController.lookup);

router.get("/utils/logs", basicAuth, async (_req, res, next) => {
  try {
    const logs = await getRequestLogs();
    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

export default router;
