import "./environment";

const DEFAULT_API_KEY = "dev-local-key";

const parseKeys = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

export const API_KEY_HEADER = (process.env.API_KEY_HEADER || "x-api-key").toLowerCase();

export const getAllowedApiKeys = (): string[] => {
  const tokens = [
    ...parseKeys(process.env.API_KEYS),
    ...parseKeys(process.env.API_KEY),
  ];

  if (tokens.length > 0) {
    return tokens;
  }

  return [DEFAULT_API_KEY];
};
