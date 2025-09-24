import { Router } from "express";
import basicAuth from "../middleware/basicAuth";
import { getRequestLogs } from "../utils/requestLogFile";

const utilsRoutes = Router();

utilsRoutes.get("/logs", basicAuth, async (_req, res, next) => {
  try {
    const logs = await getRequestLogs();
    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

export default utilsRoutes;
