import { XMLParser } from "fast-xml-parser";
import {
  wysylkaXmlConfig,
  WysylkaXmlFieldConfig,
  WysylkaXmlSectionConfig,
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
