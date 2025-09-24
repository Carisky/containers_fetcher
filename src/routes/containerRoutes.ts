import { Router } from "express";
import { ContainerController } from "../controller/containerController";
import apiKeyAuth from "../middleware/apiKeyAuth";

const containerRoutes = Router();

containerRoutes.post("/lookup-bct", apiKeyAuth, ContainerController.lookupBct);
containerRoutes.post("/lookup", apiKeyAuth, ContainerController.lookup);

export default containerRoutes;
