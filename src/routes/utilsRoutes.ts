import { Router } from "express";
import basicAuth from "../middleware/basicAuth";
import { collectSystemMetrics } from "../service/systemMetricsService";
import { getRequestLogs } from "../utils/requestLogFile";
import { renderSystemDashboardPage } from "../views/systemDashboardPage";

const utilsRoutes = Router();
const MAX_INITIAL_LOGS = 50;

const shouldHideFromDashboard = (url?: string): boolean => {
  if (!url) {
    return false;
  }

  return url.startsWith("/utils/metrics") || url.startsWith("/utils/logs");
};

const filterInternalLogs = <T extends { url?: string }>(logs: T[]): T[] =>
  logs.filter((entry) => !shouldHideFromDashboard(entry.url));

utilsRoutes.get("/dashboard", basicAuth, async (_req, res, next) => {
  try {
    const [metrics, logs] = await Promise.all([
      collectSystemMetrics().catch((error) => {
        console.error("Failed to collect system metrics", error);
        return null;
      }),
      getRequestLogs().catch((error) => {
        console.error("Failed to read request logs", error);
        return [];
      }),
    ]);

    res
      .type("html")
      .send(
        renderSystemDashboardPage({
          metrics,
          logs: filterInternalLogs(logs).slice(0, MAX_INITIAL_LOGS),
        })
      );
  } catch (error) {
    next(error);
  }
});

utilsRoutes.get("/metrics", basicAuth, async (_req, res, next) => {
  try {
    const metrics = await collectSystemMetrics();
    res.json(metrics);
  } catch (error) {
    next(error);
  }
});

utilsRoutes.get("/logs", basicAuth, async (_req, res, next) => {
  try {
    const logs = await getRequestLogs();
    res.json({ logs: filterInternalLogs(logs) });
  } catch (error) {
    next(error);
  }
});

export default utilsRoutes;
