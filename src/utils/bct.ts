import { load } from "cheerio";
import { normalizeHeader } from "./strings";
import type { BctInfo } from "../types";

const normalizeTableValue = (value: string): string | undefined => {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  if (/^[-\u2013\u2014]+$/.test(trimmed)) return undefined;
  return trimmed;
};

const buildContainerFieldMap = (html: string): Record<string, string> => {
  const doc = load(html);
  const map: Record<string, string> = {};

  doc(".container-card-table tbody tr").each((_, row) => {
    const rowEl = doc(row);
    const title = rowEl.find(".container-card-table-title").text();
    const value = rowEl.find(".container-card-table-data").text();

    const key = normalizeHeader(title);
    if (!key) return;

    const normalizedValue = normalizeTableValue(value);
    if (!normalizedValue) return;

    map[key] = normalizedValue;
  });

  return map;
};

const findFieldValue = (
  fields: Record<string, string>,
  predicate: (key: string) => boolean
): string | undefined => {
  for (const [key, value] of Object.entries(fields)) {
    if (predicate(key)) {
      return value;
    }
  }
  return undefined;
};

export function extractContainerInfoFromBctHtml(html: string): BctInfo {
  const fields = buildContainerFieldMap(html);
  const cen = findFieldValue(fields, (key) => key.includes("cen"));
  const status =
    findFieldValue(fields, (key) => key.includes("tstate")) ||
    findFieldValue(fields, (key) => key.includes("status"));

  return { cen, status };
}
