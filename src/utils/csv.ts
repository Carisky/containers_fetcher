import Papa from "papaparse";
import { normalizeHeader } from "./strings";
import type { ContainerCsvInfo } from "../types/index";

const containerKeys = [
  "numer",
  "unitnbr",
  "containernumber",
  "containerno",
  "containerid",
  "container"
] as const;

const cenPrimaryKeys = ["cennumber", "cen"] as const;
const inboundModeKeys = ["inboundmode"] as const;
const carrierSealKeys = ["carrierseal"] as const;
const vetSealKeys = ["vetseal"] as const;
const tStateKeys = ["tstate"] as const;
const customsSealKeys = ["customsseal"] as const;
const timeInKeys = ["timein", "timeindate", "timeindatetime", "commodityweightkg"] as const;
const timeOutKeys = ["timeout", "timeoutdate", "timeoutdatetime", "cargoweightkg"] as const;

const normalizeValue = (value?: string): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const pickValue = (
  row: Record<string, string | undefined>,
  keys: readonly string[]
): string | undefined => {
  for (const key of keys) {
    const candidate = normalizeValue(row[key]);
    if (candidate) return candidate;
  }
  return undefined;
};

const pickTimestamp = (
  row: Record<string, string | undefined>,
  keys: readonly string[]
): number | undefined => {
  for (const key of keys) {
    const value = normalizeValue(row[key]);
    if (!value) continue;

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const fallback = Object.values(row)
    .map(normalizeValue)
    .filter((value): value is string => Boolean(value))
    .map(value => Date.parse(value))
    .find(parsed => !Number.isNaN(parsed));

  return typeof fallback === "number" ? fallback : undefined;
};

const isLikelyCen = (value: string): boolean => {
  const upper = value.trim().toUpperCase();
  if (upper.length < 8) return false;
  if (!/[A-Z]/.test(upper)) return false;
  if (!/\d/.test(upper)) return false;
  return true;
};

const normalizeCen = (raw?: string): string | undefined => {
  const sanitized = normalizeValue(raw);
  if (!sanitized) return undefined;

  const tokens = sanitized
    .split(/[;,]/)
    .map(token => token.trim())
    .filter(token => isLikelyCen(token));

  return tokens.length > 0 ? tokens.join(",") : undefined;
};

const pickStatus = (row: Record<string, string | undefined>): string | undefined =>
  pickValue(row, customsSealKeys) ?? pickValue(row, vetSealKeys) ?? pickValue(row, tStateKeys);

const pickCen = (
  row: Record<string, string | undefined>,
  status: string | undefined
): string | undefined => {
  const candidates = [
    pickValue(row, cenPrimaryKeys),
    pickValue(row, inboundModeKeys),
    pickValue(row, carrierSealKeys),
    pickValue(row, vetSealKeys),
    pickValue(row, tStateKeys),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeCen(candidate);
    if (!normalized) continue;
    if (status && normalized === status) continue;
    return normalized;
  }

  return undefined;
};

const isRepeatedHeaderRow = (row: Record<string, string | undefined>): boolean => {
  const firstValue = pickValue(row, containerKeys);
  return firstValue !== undefined && normalizeHeader(firstValue) === "numer";
};

const shouldUseCandidate = (
  current: ContainerCsvInfo,
  candidate: ContainerCsvInfo
): boolean => {
  const currentIn = current.timeIn ?? Number.POSITIVE_INFINITY;
  const candidateIn = candidate.timeIn ?? Number.POSITIVE_INFINITY;
  if (candidateIn !== currentIn) {
    return candidateIn < currentIn;
  }

  const currentOut = current.timeOut ?? Number.NEGATIVE_INFINITY;
  const candidateOut = candidate.timeOut ?? Number.NEGATIVE_INFINITY;
  if (candidateOut !== currentOut) {
    return candidateOut > currentOut;
  }

  return false;
};

export function buildContainerInfoFromCsv(csv: string): Record<string, ContainerCsvInfo> {
  const { data } = Papa.parse<Record<string, string | undefined>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
    transformHeader: (header: string) => normalizeHeader(header),
  });

  const result: Record<string, ContainerCsvInfo> = {};

  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    if (isRepeatedHeaderRow(row)) continue;

    const cont = pickValue(row, containerKeys);
    if (!cont) continue;

    const status = pickStatus(row);
    const cen = pickCen(row, status);
    const timeIn = pickTimestamp(row, timeInKeys);
    const timeOut = pickTimestamp(row, timeOutKeys);

    const candidate: ContainerCsvInfo = {
      cen,
      t_state: status,
      timeIn,
      timeOut,
      date: timeIn ?? timeOut ?? 0,
    };

    const existing = result[cont];
    if (!existing) {
      result[cont] = candidate;
      continue;
    }

    if (shouldUseCandidate(existing, candidate)) {
      result[cont] = {
        ...candidate,
        cen: candidate.cen ?? existing.cen,
        t_state: candidate.t_state ?? existing.t_state,
      };
      continue;
    }

    if (!existing.cen && candidate.cen) {
      existing.cen = candidate.cen;
    }

    if (!existing.t_state && candidate.t_state) {
      existing.t_state = candidate.t_state;
    }
  }

  return result;
}

