import { Router } from "express";
import type { GoogleSheetsTable } from "../config/googleSheetsTables";
import {
  findGoogleSheetsTable,
  listGoogleSheetsTables,
} from "../config/googleSheetsTables";

const toResponse = (table: GoogleSheetsTable) => ({
  configKey: table.configKey,
  key: table.key,
  spreadsheetId: table.id,
  sheetGid: table.gid,
  sheetGidNumber: table.gidNumber,
  sheetName: table.sheetName ?? null,
  spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${table.id}`,
  sheetUrl: `https://docs.google.com/spreadsheets/d/${table.id}/edit#gid=${table.gid}`,
});

const googleTablesRoutes = Router();

googleTablesRoutes.get("/", (_req, res) => {
  const tables = listGoogleSheetsTables().map(toResponse);
  res.json({ tables });
});

googleTablesRoutes.get("/:identifier", (req, res) => {
  const identifier = decodeURIComponent(req.params.identifier);
  const rawBy = req.query.by;
  const by = typeof rawBy === "string" ? rawBy : undefined;

  const table = findGoogleSheetsTable(identifier, by);
  if (!table) {
    res.status(404).json({
      status: "error",
      message: `Google Sheets table "${by ? `${identifier} (${by})` : identifier}" not found.`,
    });
    return;
  }

  res.json(toResponse(table));
});

export default googleTablesRoutes;
