import { Router } from "express";
import containerRoutes from "./containerRoutes";
import firebirdRoutes from "./firebirdRoutes";
import googleRoutes from "./googleRoutes";
import utilsRoutes from "./utilsRoutes";
import healthcheckRoutes from "./healthcheckRoutes";

const routes = Router();

routes.use("/", healthcheckRoutes);
routes.use("/", containerRoutes);
routes.use("/huzar/winsad/db", firebirdRoutes);
routes.use("/google", googleRoutes);
routes.use("/utils", utilsRoutes);

export default routes;
