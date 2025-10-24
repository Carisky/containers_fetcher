import { Router } from "express";
import apiKeyAuth from "../middleware/apiKeyAuth";
import googleTablesRoutes from "./googleTablesRoutes";
import {
  appendTestToHeader,
  fetchTestColumn,
} from "../service/google/sheetsService";

const googleRoutes = Router();

googleRoutes.use(apiKeyAuth);
googleRoutes.use("/tables", googleTablesRoutes);

googleRoutes.get("/test", async (_req, res) => {
  try {
    const result = await fetchTestColumn();
    res.json({
      spreadsheetId: result.spreadsheetId,
      sheetName: result.sheetName,
      header: result.header,
      count: result.values.length,
      values: result.values,
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

googleRoutes.post("/test-write", async (_req, res) => {
  try {
    const result = await appendTestToHeader();
    res.json({
      spreadsheetId: result.spreadsheetId,
      sheetName: result.sheetName,
      cell: result.cell,
      previousValue: result.previousValue,
      newValue: result.newValue,
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default googleRoutes;
