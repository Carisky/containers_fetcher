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
    .split(/[;,\s]+/)
    .map(token => token.trim())
    .filter(token => isLikelyCen(token));

  return tokens.length > 0 ? tokens.join(",") : undefined;
};

const pickStatus = (row: Record<string, string | undefined>): string | undefined =>
  pickValue(row, tStateKeys) ?? pickValue(row, customsSealKeys) ?? pickValue(row, vetSealKeys);

const CEN_CONFIDENCE = {
  NONE: 0,
  FALLBACK: 1,
  SECONDARY: 2,
  PRIMARY: 3,
} as const;

const NO_CEN_VALUE = "";

const pickCen = (
  row: Record<string, string | undefined>,
  status: string | undefined
): { value: string | undefined; confidence: number } => {
  const primary = normalizeCen(pickValue(row, cenPrimaryKeys));
  if (primary && (!status || primary !== status)) {
    return { value: primary, confidence: CEN_CONFIDENCE.PRIMARY };
  }

  return { value: NO_CEN_VALUE, confidence: CEN_CONFIDENCE.PRIMARY };
};;

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

  type CandidateInfo = ContainerCsvInfo & { cenConfidence: number; hasExplicitNoCen: boolean };

  const result: Record<string, CandidateInfo> = {};

  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    if (isRepeatedHeaderRow(row)) continue;

    const cont = pickValue(row, containerKeys);
    if (!cont) continue;

    const status = pickStatus(row);
    const { value: cenValue, confidence: cenConfidence } = pickCen(row, status);
    const timeIn = pickTimestamp(row, timeInKeys);
    const timeOut = pickTimestamp(row, timeOutKeys);

    const isExplicitNoCen = cenValue === NO_CEN_VALUE;
    const candidate: CandidateInfo = {
      cen: isExplicitNoCen ? undefined : cenValue,
      cenConfidence: isExplicitNoCen
        ? CEN_CONFIDENCE.NONE
        : cenValue
          ? cenConfidence
          : CEN_CONFIDENCE.NONE,
      hasExplicitNoCen: isExplicitNoCen,
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
        cenConfidence: candidate.cen ? candidate.cenConfidence : existing.cenConfidence,
        hasExplicitNoCen: candidate.hasExplicitNoCen || existing.hasExplicitNoCen,
        t_state: candidate.t_state ?? existing.t_state,
      };
      continue;
    }

    if (candidate.cen) {
      if (!existing.cen || candidate.cenConfidence > existing.cenConfidence) {
        existing.cen = candidate.cen;
        existing.cenConfidence = candidate.cenConfidence;
      }
    } else if (candidate.hasExplicitNoCen) {
      existing.hasExplicitNoCen = true;
    }

    if (!existing.t_state && candidate.t_state) {
      existing.t_state = candidate.t_state;
    }
  }

  const output: Record<string, ContainerCsvInfo> = {};
  for (const [container, info] of Object.entries(result)) {
    const { cenConfidence: _omit, hasExplicitNoCen, ...rest } = info;
    if (!rest.cen && hasExplicitNoCen) {
      rest.cen = NO_CEN_VALUE;
    }
    output[container] = rest;
  }

  return output;
}


