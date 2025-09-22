import { RequestHandler } from "express";
import { API_KEY_HEADER, getAllowedApiKeys } from "../config/authConfig";

const unauthorized = (res: Parameters<RequestHandler>[1]) => {
  res.setHeader("WWW-Authenticate", "ApiKey");
  res.status(401).json({ message: "Unauthorized" });
};

const parseAuthorizationHeader = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const [rawScheme, token = ""] = trimmed.split(/\s+/, 2);
  const scheme = rawScheme.toLowerCase();

  if (scheme === "bearer" || scheme === "apikey") {
    return token.trim();
  }

  return undefined;
};

const extractApiKey = (reqHeaderValue: string | string[] | undefined): string | undefined => {
  if (Array.isArray(reqHeaderValue)) {
    return reqHeaderValue.length > 0 ? String(reqHeaderValue[0]).trim() : undefined;
  }

  if (typeof reqHeaderValue === "string") {
    return reqHeaderValue.trim();
  }

  return undefined;
};

export const apiKeyAuth: RequestHandler = (req, res, next) => {
  const directHeader = extractApiKey(req.headers[API_KEY_HEADER]);
  const authHeader = parseAuthorizationHeader(
    typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
  );

  const candidate = directHeader || authHeader;
  if (!candidate) {
    unauthorized(res);
    return;
  }

  const allowedKeys = new Set(getAllowedApiKeys());
  if (!allowedKeys.has(candidate)) {
    unauthorized(res);
    return;
  }

  next();
};

export default apiKeyAuth;
