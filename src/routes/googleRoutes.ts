import { Router } from "express";
import apiKeyAuth from "../middleware/apiKeyAuth";
import { fetchTestColumn } from "../service/google/sheetsService";

const googleRoutes = Router();

googleRoutes.use(apiKeyAuth);

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

export default googleRoutes;
