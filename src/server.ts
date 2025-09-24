import "./config/environment";
import express from "express";
import cors from "cors";
import containerRoutes from "./routes";
import requestLogger from "./middleware/requestLogger";

const app = express();
app.use(cors());
app.use(express.json());
app.use(requestLogger);

app.use("/", containerRoutes);

const PORT = Number.parseInt(process.env.PORT || "3400", 10);
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
