import type { Request, Response } from "express";
import {
  fetchBctForContainer,
  fetchContainerInfo,
} from "../service/containerService";
import { mapWithConcurrency } from "../utils/concurrency";
import { sleep } from "../utils/time";

const DEFAULT_BCT_CONCURRENCY = 5;
const DEFAULT_CONTAINER_CONCURRENCY = 3;

const parseConcurrency = (
  raw: unknown,
  fallback: number
): number => {
  if (typeof raw !== "string") {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed > 0 ? parsed : fallback;
};

const sanitizeContainers = (containers: unknown): string[] => {
  if (!Array.isArray(containers)) {
    return [];
  }

  const normalized = containers
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);

  return normalized;
};

export class ContainerController {
  static async lookupBct(req: Request, res: Response) {
    const normalized = sanitizeContainers((req.body as { containers?: unknown }).containers);
    if (normalized.length === 0) {
      return res.status(400).json({ error: "No containers provided" });
    }

    const concurrency = parseConcurrency(
      process.env.BCT_LOOKUP_CONCURRENCY,
      DEFAULT_BCT_CONCURRENCY
    );

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
    const normalized = sanitizeContainers((req.body as { containers?: unknown }).containers);

    const wantT =
      String(
        req.query?.t_status ?? (req.body as any)?.t_status ?? ""
      ).toLowerCase() === "true" || (req.body as any)?.t_status === true;

    if (normalized.length === 0) {
      return res.status(400).json({ error: "No containers provided" });
    }

    const concurrency = parseConcurrency(
      process.env.CONTAINER_LOOKUP_CONCURRENCY,
      DEFAULT_CONTAINER_CONCURRENCY
    );

    const results = await mapWithConcurrency(normalized, concurrency, async (cont) => {
      const info = await fetchContainerInfo(cont);
      return { cont, info };
    });

    const infoMap: Record<string, { cen?: string; t_state?: string }> = {};
    for (const { info } of results) {
      Object.assign(infoMap, info);
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
