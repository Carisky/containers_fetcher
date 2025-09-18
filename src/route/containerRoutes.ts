import { Router } from "express";
import { ContainerController } from "../controller/containerController";


const router = Router();


router.post("/lookup-bct", ContainerController.lookupBct);
router.post("/lookup", ContainerController.lookup);


export default router;