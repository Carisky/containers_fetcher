import type { Request, Response } from "express";
import {
  fetchBctForContainer,
  fetchContainerInfo,
} from "../service/containerService";
import { mapWithConcurrency } from "../utils/concurrency";
import { sleep } from "../utils/time";

const DEFAULT_BCT_CONCURRENCY = 5;

const parseConcurrency = (value: unknown): number => {
  if (typeof value !== "string") {
    return DEFAULT_BCT_CONCURRENCY;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BCT_CONCURRENCY;
  }

  return parsed > 0 ? parsed : DEFAULT_BCT_CONCURRENCY;
};

export class ContainerController {
  static async lookupBct(req: Request, res: Response) {
    const { containers } = req.body as { containers: string[] };
    if (!Array.isArray(containers) || containers.length === 0) {
      return res.status(400).json({ error: "No containers provided" });
    }

    const normalized = containers
      .map((c) => String(c ?? "").trim())
      .filter((c) => c.length > 0);

    if (normalized.length === 0) {
      return res.status(400).json({ error: "No containers provided" });
    }

    const concurrency = parseConcurrency(process.env.BCT_LOOKUP_CONCURRENCY);
    const results = await mapWithConcurrency(normalized, concurrency, async (cont) => {
      const { cen, status } = await fetchBctForContainer(cont);
      return { cont, cen, status };
    });

    const map: Record<string, { status: string; cen?: string }> = {};
    for (const { cont, cen, status } of results) {
      if (status || cen) {
        map[cont] = { status: status ?? "", cen };
      }
    }

    return res.json({ map });
  }

  static async lookup(req: Request, res: Response) {
    const { containers } = req.body as { containers: string[] };
    const wantT =
      String(
        req.query?.t_status ?? (req.body as any)?.t_status ?? ""
      ).toLowerCase() === "true" || (req.body as any)?.t_status === true;

    if (!Array.isArray(containers) || containers.length === 0) {
      return res.status(400).json({ error: "No containers provided" });
    }

    const infoMap: Record<string, { cen?: string; t_state?: string }> = {};
    for (const cont of containers) {
      const info = await fetchContainerInfo(cont);
      Object.assign(infoMap, info);
      await sleep(2000);
    }

    if (!wantT) {
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(infoMap)) map[k] = v.cen ?? "";
      return res.json({ map });
    } else {
      const map: Record<string, { cen: string; t_state: string }> = {};
      for (const [k, v] of Object.entries(infoMap)) {
        map[k] = { cen: v.cen ?? "", t_state: v.t_state ?? "" };
      }
      return res.json({ map });
    }
  }
}