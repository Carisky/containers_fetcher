import { Router } from "express";
import containerRoutes from "./containerRoutes";
import firebirdRoutes from "./firebirdRoutes";
import utilsRoutes from "./utilsRoutes";

const routes = Router();

routes.use("/", containerRoutes);
routes.use("/huzar/winsad/db", firebirdRoutes);
routes.use("/utils", utilsRoutes);

export default routes;
