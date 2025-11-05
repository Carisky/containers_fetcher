import { XMLParser } from "fast-xml-parser";
import {
  wysylkaXmlConfig,
  WysylkaXmlFieldConfig,
  WysylkaXmlSectionConfig,
  type WysylkaXmlFieldAggregator,
} from "../config/wysylkiXmlConfig";

type ExtractedFields = Record<string, string | null>;

type WysylkaRow = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  ignoreDeclaration: true,
  trimValues: true,
  parseTagValue: true,
  parseAttributeValue: false,
  ignorePiTags: true,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  removeNSPrefix: true,
});

const regexCache = new Map<string, RegExp>();
const invalidRegexPatterns = new Set<string>();
const regexMismatchCache = new Set<string>();

const resolveRegex = (pattern: string): RegExp | null => {
  if (!pattern) {
    return null;
  }

  if (regexCache.has(pattern)) {
    return regexCache.get(pattern) ?? null;
  }

  if (invalidRegexPatterns.has(pattern)) {
    return null;
  }

  try {
    const compiled = new RegExp(pattern);
    regexCache.set(pattern, compiled);
    return compiled;
  } catch (error) {
    console.warn(
      `[wysylkaXml] Invalid regex '${pattern}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    invalidRegexPatterns.add(pattern);
    return null;
  }
};

const sanitizeXml = (value: string): string => {
  if (!value) {
    return "";
  }

  const trimmed = value.replace(/^[\s\u0000-\u001F\uFEFF]+/, "");
  const xmlDeclarationIndex = trimmed.indexOf("<?xml");
  const candidate = xmlDeclarationIndex >= 0 ? trimmed.slice(xmlDeclarationIndex) : trimmed;
  const firstTag = candidate.indexOf("<");
  const sliced = firstTag > 0 ? candidate.slice(firstTag) : candidate;
  return sliced.replace(/\u0000+/g, "");
};

type PathSegment = {
  key: string;
  index?: number;
};

const parsePathSegments = (path: string): PathSegment[] => {
  return path.split(".").map((segmentRaw) => {
    const segment = segmentRaw.trim();
    if (!segment) {
      throw new Error(`Invalid empty segment in path '${path}'`);
    }

    const match = /^([^\[]+)(?:\[(\d+)\])?$/.exec(segment);
    if (!match) {
      throw new Error(`Unsupported segment format '${segment}' in path '${path}'`);
    }

    const [, key, indexRaw] = match;
    return {
      key,
      index: typeof indexRaw === "string" ? Number.parseInt(indexRaw, 10) : undefined,
    };
  });
};

const coerceToString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      const coerced = coerceToString(element);
      if (coerced !== null) {
        return coerced;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    const textNode = (value as Record<string, unknown>)["#text"];
    if (typeof textNode === "string") {
      return textNode;
    }

    return null;
  }

  return null;
};

const unwrapSingleChild = (value: unknown): unknown => {
  let current = value;
  const visited = new Set<unknown>();

  while (
    current &&
    typeof current === "object" &&
    !Array.isArray(current)
  ) {
    if (visited.has(current)) {
      break;
    }
    visited.add(current);

    const entries = Object.entries(current as Record<string, unknown>).filter(
      ([key]) => typeof key === "string" && !key.startsWith("@_")
    );

    if (entries.length !== 1) {
      break;
    }

    const [, next] = entries[0];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      return next;
    }

    current = next;
  }

  return current;
};

const getValueAtPath = (root: unknown, path: string): string | null => {
  if (root === null || root === undefined) {
    return null;
  }

  const segments = parsePathSegments(path);
  let current: unknown = root;
  let index = 0;

  while (index < segments.length) {
    if (current === null || current === undefined) {
      return null;
    }

    if (Array.isArray(current)) {
      return null;
    }

    if (typeof current !== "object") {
      return null;
    }

    const segment = segments[index];
    const container = current as Record<string, unknown>;
    let next: unknown = container[segment.key];

    if (next === undefined) {
      const unwrapped = unwrapSingleChild(current);
      if (unwrapped !== current) {
        current = unwrapped;
        continue;
      }
      return null;
    }

    if (Array.isArray(next)) {
      if (segment.index === undefined) {
        return null;
      }
      next = next[segment.index];
    } else if (segment.index !== undefined) {
      return null;
    }

    current = next;
    index += 1;
  }

  return coerceToString(current);
};

const collectNodes = (
  root: unknown,
  path: readonly string[],
): unknown[] => {
  const results: unknown[] = [];

  const traverse = (current: unknown, index: number): void => {
    if (index === path.length) {
      results.push(current);
      return;
    }

    if (current === null || current === undefined) {
      return;
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        traverse(entry, index);
      }
      return;
    }

    if (typeof current !== "object") {
      return;
    }

    const record = current as Record<string, unknown>;
    const next = record[path[index]];
    if (next === undefined) {
      return;
    }

    traverse(next, index + 1);
  };

  traverse(root, 0);
  return results;
};

const collectSupportingDocuments = (root: unknown): unknown[] => {
  const results: unknown[] = [];

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }

    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === "SupportingDocument") {
        if (Array.isArray(value)) {
          results.push(...value);
        } else if (value !== null && value !== undefined) {
          results.push(value);
        }
      } else if (
        value !== null &&
        (typeof value === "object" || Array.isArray(value))
      ) {
        visit(value);
      }
    }
  };

  visit(root);
  return results;
};

const formatNumberWithComma = (value: number): string =>
  value.toFixed(2).replace(".", ",");

const parseAmountAndCurrency = (
  raw: string,
): { amount: number; currency: string | null } | null => {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return null;
  }

  const amountMatch = collapsed.match(/[-+]?\d[\d\s.,]*/);
  if (!amountMatch) {
    return null;
  }

  const amountCandidate = amountMatch[0].replace(/\s+/g, "");
  const commaIndex = amountCandidate.lastIndexOf(",");
  const dotIndex = amountCandidate.lastIndexOf(".");

  let normalizedAmount = amountCandidate;
  if (commaIndex > dotIndex) {
    normalizedAmount = amountCandidate.replace(/\./g, "").replace(",", ".");
  } else if (dotIndex > commaIndex) {
    normalizedAmount = amountCandidate.replace(/,/g, "");
  } else {
    normalizedAmount = amountCandidate.replace(",", ".");
  }

  const amount = Number.parseFloat(normalizedAmount);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const currencyMatch = collapsed.match(/\b([A-Z]{3})\b/i);
  const currency = currencyMatch ? currencyMatch[1].toUpperCase() : null;

  return { amount, currency };
};

function aggregateHouseConsignmentSupportingDocumentsSum(
  parsed: unknown,
): string | null {
  const candidatePaths: ReadonlyArray<readonly string[]> = [
    [
      "IE029PL",
      "CC029C",
      "Consignment",
    ],
    [
      "IE028PL",
      "CC028C",
      "Consignment",
    ],
    [
      "IE045PL",
      "CC045C",
      "Consignment",
    ],
  ];

  const consignments = candidatePaths.flatMap((path) =>
    collectNodes(parsed, path),
  );

  const documentNodes = consignments.flatMap((node) =>
    collectSupportingDocuments(node),
  );

  let totalCents = 0;
  let found = false;
  const currencies = new Set<string>();

  for (const node of documentNodes) {
    let complementSource: unknown;
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      complementSource =
        record["complementOfInformation"] ??
        record["ComplementOfInformation"] ??
        record["COMPLEMENTOFINFORMATION"];
    } else {
      complementSource = node;
    }

    const complement = getFirstNonEmptyString(complementSource);
    if (!complement) {
      continue;
    }

    const parsedValue = parseAmountAndCurrency(complement);
    if (!parsedValue) {
      continue;
    }

    const cents = Math.round(parsedValue.amount * 100);
    if (!Number.isFinite(cents)) {
      continue;
    }

    totalCents += cents;
    if (parsedValue.currency) {
      currencies.add(parsedValue.currency);
    }
    found = true;
  }

  if (!found) {
    return null;
  }

  const total = totalCents / 100;
  const formattedTotal = formatNumberWithComma(total);
  const currencyLabel =
    currencies.size > 0 ? ` ${Array.from(currencies).join("/")}` : "";

  return `${formattedTotal}${currencyLabel}`.trim();
}

const TRANSIT_OPERATION_RELEASE_DATE_PATHS: readonly string[] = [
  "IE029PL.CC029C.TransitOperation.releaseDate",
  "IE028PL.CC028C.TransitOperation.releaseDate",
  "IE045PL.CC045C.TransitOperation.releaseDate",
];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function aggregateTransitOperationReleaseDateValue(parsed: unknown): string | null {
  for (const path of TRANSIT_OPERATION_RELEASE_DATE_PATHS) {
    const candidate = getValueAtPath(parsed, path);
    if (!candidate) {
      continue;
    }

    const trimmed = candidate.trim();
    if (!ISO_DATE_PATTERN.test(trimmed)) {
      continue;
    }

    return trimmed;
  }

  return null;
}

function runFieldAggregator(
  key: WysylkaXmlFieldAggregator,
  parsed: unknown,
): string | null {
  switch (key) {
    case "houseConsignmentSupportingDocumentsSum":
      return aggregateHouseConsignmentSupportingDocumentsSum(parsed);
    case "transitOperationReleaseDateValue":
      return aggregateTransitOperationReleaseDateValue(parsed);
    default:
      return null;
  }
}

const buildEmptyResult = (fields: readonly WysylkaXmlFieldConfig[]): ExtractedFields => {
  return Object.fromEntries(fields.map((field) => [field.name, null]));
};

const extractFieldsFromXml = (
  xml: string,
  fields: readonly WysylkaXmlFieldConfig[],
  sourceKey: string
): ExtractedFields => {
  if (fields.length === 0) {
    return {};
  }

  const sanitized = sanitizeXml(xml);
  if (!sanitized) {
    return buildEmptyResult(fields);
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(sanitized);
  } catch (error) {
    console.warn(
      `[wysylkaXml] Failed to parse XML from '${sourceKey}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return buildEmptyResult(fields);
  }

  const output: ExtractedFields = {};
  for (const field of fields) {
    let resolved: string | null = null;

    if (field.aggregate) {
      try {
        const aggregated = runFieldAggregator(field.aggregate, parsed);
        if (aggregated !== null && aggregated.trim().length > 0) {
          resolved = aggregated;
        }
      } catch (error) {
        console.warn(
          `[wysylkaXml] Failed to aggregate field '${field.name}' using aggregator '${field.aggregate}': ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (resolved === null) {
      for (const candidatePath of field.paths) {
        try {
          const rawCandidate = getValueAtPath(parsed, candidatePath);
          if (rawCandidate === null) {
            continue;
          }

          const candidate = rawCandidate.trim();
          if (candidate.length === 0) {
            continue;
          }

          if (field.regex) {
            const regex = resolveRegex(field.regex);
            if (regex) {
              if (!regex.test(candidate)) {
                const cacheKey = `${field.regex}::${candidatePath}`;
                if (!regexMismatchCache.has(cacheKey)) {
                  regexMismatchCache.add(cacheKey);
                  console.warn(
                    `[wysylkaXml] Value '${candidate}' for path '${candidatePath}' does not match regex '${field.regex}' (source '${sourceKey}').`
                  );
                }
                continue;
              }
            }
          }

          resolved = candidate;
          break;
        } catch (error) {
          console.warn(
            `[wysylkaXml] Failed to resolve path '${candidatePath}' for '${sourceKey}': ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    output[field.name] = resolved;
  }

  return output;
};

const extractSection = (
  row: WysylkaRow,
  section: WysylkaXmlSectionConfig
): [string, ExtractedFields] => {
  const rawValue = row[section.source];
  if (typeof rawValue !== "string") {
    return [section.targetKey, buildEmptyResult(section.fields)];
  }

  return [
    section.targetKey,
    extractFieldsFromXml(rawValue, section.fields, section.source),
  ];
};

export const parseXmlFieldsForWysylkaRow = (
  row: WysylkaRow
): Record<string, ExtractedFields> => {
  const entries = wysylkaXmlConfig.map((section) => extractSection(row, section));
  return Object.fromEntries(entries);
};

function getFirstNonEmptyString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      const candidate = getFirstNonEmptyString(element);
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["#text"] === "string") {
      const direct = record["#text"].trim();
      if (direct.length > 0) {
        return direct;
      }
    }

    for (const nested of Object.values(record)) {
      const candidate = getFirstNonEmptyString(nested);
      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

function extractNameLike(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      const candidate = extractNameLike(element);
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const preferredKeys = ["name", "Name", "personName", "fullName", "@_name"];
    for (const key of preferredKeys) {
      const candidate = record[key];
      if (candidate !== undefined) {
        const resolved = getFirstNonEmptyString(candidate);
        if (resolved) {
          return resolved;
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(record, "#text")) {
      const textCandidate = record["#text"];
      if (typeof textCandidate === "string") {
        const trimmed = textCandidate.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }

    const contactPerson = record["ContactPerson"];
    if (contactPerson !== undefined) {
      const contactCandidate = extractNameLike(contactPerson);
      if (contactCandidate) {
        return contactCandidate;
      }
    }

    for (const nested of Object.values(record)) {
      const candidate = extractNameLike(nested);
      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

function extractFirstMatchingString(
  value: unknown,
  predicate: (key: string) => boolean,
  valueExtractor: (value: unknown) => string | null,
): string | null {
  if (Array.isArray(value)) {
    for (const element of value) {
      const candidate = extractFirstMatchingString(element, predicate, valueExtractor);
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if (predicate(key)) {
        const extracted = valueExtractor(nested);
        if (extracted) {
          return extracted;
        }
      }
    }

    for (const nested of Object.values(record)) {
      const candidate = extractFirstMatchingString(nested, predicate, valueExtractor);
      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

const DECLARANT_KEY_PATTERNS = [
  /holderof/i,
  /declarant/i,
  /zglaszaj/i,
  /submitter/i,
  /representative/i,
];

const COMMENT_KEY_PATTERNS = [
  /comment/i,
  /komentarz/i,
  /remark/i,
  /uwag/i,
  /notes?/i,
];

function matchesAnyPattern(patterns: readonly RegExp[], key: string): boolean {
  for (const pattern of patterns) {
    if (pattern.test(key)) {
      return true;
    }
  }
  return false;
}

export const extractDeclarantAndCommentFromXml = (
  xml: string
): { declarant: string | null; comment: string | null } => {
  const sanitized = sanitizeXml(xml);
  if (!sanitized) {
    return { declarant: null, comment: null };
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(sanitized);
  } catch (error) {
    console.warn(
      `[wysylkaXml] Failed to parse XML while extracting declarant/comment: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { declarant: null, comment: null };
  }

  const declarant = extractFirstMatchingString(
    parsed,
    (key) => matchesAnyPattern(DECLARANT_KEY_PATTERNS, key),
    extractNameLike
  );

  const comment = extractFirstMatchingString(
    parsed,
    (key) => matchesAnyPattern(COMMENT_KEY_PATTERNS, key),
    getFirstNonEmptyString
  );

  return {
    declarant: declarant ?? null,
    comment: comment ?? null,
  };
};
