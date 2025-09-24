import { Router } from "express";
import {
  checkFirebirdConnection,
  fetchCmrSampleRows,
  fetchWysylkiByMrn,
} from "../service/firebird";
import { parseXmlFieldsForWysylkaRow } from "../utils/wysylkaXml";
import { getFirstQueryParam } from "./helpers/queryParams";

const firebirdRoutes = Router();

firebirdRoutes.get("/status", async (_req, res) => {
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

firebirdRoutes.get("/test", async (_req, res) => {
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

firebirdRoutes.get("/wysylki/mrn/:mrn", async (req, res) => {
  const rawMrn = typeof req.params.mrn === "string" ? req.params.mrn : "";
  const normalizedMrn = rawMrn.trim();
  const rawFileCode = getFirstQueryParam(req.query.fileCode);
  const normalizedFileCode = rawFileCode.trim();
  const rawLimitValue = getFirstQueryParam(req.query.limit);
  const parsedLimit =
    rawLimitValue.trim().length > 0 ? Number.parseInt(rawLimitValue, 10) : Number.NaN;
  const requestedLimit = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
  const rawFormatValue = getFirstQueryParam(req.query.format);
  const normalizedFormat = rawFormatValue.trim().toLowerCase();
  const preferXml = normalizedFormat === "xml";
  const effectiveLimit =
    requestedLimit !== undefined
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50)
      : preferXml
        ? 1
        : undefined;

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
      limit: requestedLimit,
      preferXml,
      includeDocumentXml: !preferXml,
    });
    const enrichedRows = rows.map((row) => ({
      ...row,
      ...parseXmlFieldsForWysylkaRow(row),
    }));

    res.json({
      mrn: normalizedMrn,
      fileCode: normalizedFileCode || undefined,
      format: preferXml ? "xml" : normalizedFormat || undefined,
      limit: effectiveLimit,
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

export default firebirdRoutes;
