import { existsSync } from "fs";
import path from "path";
import pug from "pug";
import type { SystemMetrics } from "../service/systemMetricsService";
import type { RequestLogEntry } from "../utils/requestLogFile";

type DashboardTemplateInput = {
  metrics: SystemMetrics | null;
  logs: RequestLogEntry[];
};

const resolveTemplatePath = (): string => {
  const candidates = [
    path.join(__dirname, "systemDashboard.pug"),
    path.join(process.cwd(), "src", "views", "systemDashboard.pug"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
};

const templatePath = resolveTemplatePath();
const compileTemplate = pug.compileFile(templatePath, {
  cache: process.env.NODE_ENV === "production",
});

const replacer = (_key: string, value: unknown) => {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value;
};

const serializeForScript = (value: unknown): string => {
  if (value === undefined) {
    return "undefined";
  }

  const json = JSON.stringify(value, replacer);
  if (json === undefined) {
    return "undefined";
  }

  return json.replace(/</g, "\\u003c");
};

export const renderSystemDashboardPage = ({
  metrics,
  logs,
}: DashboardTemplateInput): string =>
  compileTemplate({
    initialMetricsJson: serializeForScript(metrics),
    initialLogsJson: serializeForScript(logs),
  });

export default renderSystemDashboardPage;
