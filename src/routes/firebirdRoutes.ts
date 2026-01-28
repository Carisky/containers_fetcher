import { Router } from "express";
import {
  checkFirebirdConnection,
  fetchCmrSampleRows,
  fetchRejestrEntriesByDeclarationDate,
  fetchUsualRejestrEntriesByDeclarationDate,
  fetchWysylkiByCreationDate,
  fetchWysylkiByMrn,
} from "../service/firebird";
import {
  extractDeclarantAndCommentFromXml,
  parseXmlFieldsForWysylkaRow,
} from "../utils/wysylkaXml";
import { getFirstQueryParam } from "./helpers/queryParams";
import { isIsoDateOnlyFormat } from "../service/firebird/dateUtils";

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

firebirdRoutes.get("/mrn/:mrn", async (req, res) => {
  const rawMrn = typeof req.params.mrn === "string" ? req.params.mrn : "";
  const normalizedMrn = rawMrn.trim();
  const rawFileCode = getFirstQueryParam(req.query.fileCode);
  const normalizedFileCode = rawFileCode.trim();
  const rawLimitValue = getFirstQueryParam(req.query.limit);
  const parsedLimit =
    rawLimitValue.trim().length > 0 ? Number.parseInt(rawLimitValue, 10) : Number.NaN;
  const requestedLimit = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
  const effectiveLimit =
    requestedLimit !== undefined
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50)
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
      includeDocumentXml: false,
      includeResponseXml: true,
    });

    const sanitizedRows = rows.map((row) => {
      const clone: Record<string, unknown> = { ...row };
      const rawOdpowiedz =
        typeof clone["odpowiedzXml"] === "string" ? (clone["odpowiedzXml"] as string) : "";
      const { declarant, comment } = extractDeclarantAndCommentFromXml(rawOdpowiedz);

      delete clone["odpowiedzXml"];

      return {
        ...clone,
        zglaszajacy: declarant,
        komentarz: comment,
      };
    });

    res.json({
      mrn: normalizedMrn,
      fileCode: normalizedFileCode || undefined,
      limit: effectiveLimit,
      count: sanitizedRows.length,
      rows: sanitizedRows,
    });
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

firebirdRoutes.get("/wysylki/date/:date", async (req, res) => {
  const rawDate = typeof req.params.date === "string" ? req.params.date : "";
  const normalizedDate = rawDate.trim();
  const rawFileCode = getFirstQueryParam(req.query.fileCode);
  const normalizedFileCode = rawFileCode.trim();
  const rawGrn = getFirstQueryParam(req.query.grn);
  const normalizedGrn = rawGrn.trim();
  const rawFormatValue = getFirstQueryParam(req.query.format);
  const normalizedFormat = rawFormatValue.trim().toLowerCase();
  const preferXml = normalizedFormat === "xml";

  if (!normalizedDate) {
    res.status(400).json({
      status: "error",
      message: "Route parameter `date` must be a non-empty string.",
    });
    return;
  }

  try {
    const rows = await fetchWysylkiByCreationDate(normalizedDate, {
      fileCode: normalizedFileCode || undefined,
      preferXml,
      includeDocumentXml: !preferXml,
      includeResponseXml: true,
    });
    const enrichedRows = rows.map((row) => {
      const sanitized: Record<string, unknown> = {
        ...row,
        ...parseXmlFieldsForWysylkaRow(row),
      };
      delete sanitized["odpowiedzXml"];
      delete sanitized["odpowiedzXmlBytes"];
      return sanitized;
    });

    const filteredRows =
      normalizedGrn.length > 0
        ? enrichedRows.filter((row) => {
            const fields = row["odpowiedzXmlFields"];
            const grnValue =
              fields &&
              typeof fields === "object" &&
              fields !== null &&
              typeof (fields as Record<string, unknown>)["grn"] === "string"
                ? ((fields as Record<string, unknown>)["grn"] as string).trim()
                : "";
            return grnValue === normalizedGrn;
          })
        : enrichedRows;

    res.json({
      date: normalizedDate,
      fileCode: normalizedFileCode || undefined,
      grn: normalizedGrn || undefined,
      format: preferXml ? "xml" : normalizedFormat || undefined,
      count: filteredRows.length,
      rows: filteredRows,
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

firebirdRoutes.get("/rejestr/:date", async (req, res) => {
  const rawDate = typeof req.params.date === "string" ? req.params.date : "";
  const normalizedDate = rawDate.trim();
  const rawDevFlag = getFirstQueryParam(req.query.dev);
  const includeXml = rawDevFlag.trim().toLowerCase() === "true";
  const rawUsualFlag = getFirstQueryParam(req.query.usual);
  const rawModeFlag = getFirstQueryParam(req.query.mode);
  const rawFlagFlag = getFirstQueryParam(req.query.flag);
  const normalizedFlagValue =
    rawUsualFlag.trim().toLowerCase() ||
    rawModeFlag.trim().toLowerCase() ||
    rawFlagFlag.trim().toLowerCase();
  const hasUsualKey = Object.prototype.hasOwnProperty.call(req.query ?? {}, "usual");
  const useUsual =
    normalizedFlagValue === "usual" ||
    ["1", "true", "yes", "y", "on"].includes(normalizedFlagValue) ||
    (hasUsualKey && normalizedFlagValue === "");

  if (!normalizedDate) {
    res.status(400).json({
      status: "error",
      message: "Route parameter `date` must be a non-empty string.",
    });
    return;
  }

  if (!isIsoDateOnlyFormat(normalizedDate)) {
    res.status(400).json({
      status: "error",
      message: "Date must be provided in the ISO format YYYY-MM-DD.",
    });
    return;
  }

  try {
    const rows = useUsual
      ? await fetchUsualRejestrEntriesByDeclarationDate(normalizedDate)
      : await fetchRejestrEntriesByDeclarationDate(normalizedDate);
    if (rows.length === 0) {
      if (useUsual) {
        res.json({
          date: normalizedDate,
          count: 0,
          rows: [],
        });
        return;
      }

      res.status(404).json({
        status: "error",
        message: `No registry entries found for date ${normalizedDate}.`,
      });
      return;
    }

    const sanitizedRows = includeXml
      ? rows
      : rows.map((row) => {
          const { xmlDoc, ...rest } = row;
          return rest;
        });

    res.json({
      date: normalizedDate,
      count: sanitizedRows.length,
      rows: sanitizedRows,
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default firebirdRoutes;
