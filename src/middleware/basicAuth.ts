import { RequestHandler } from "express";

const DEFAULT_USERNAME = "admin";
const DEFAULT_PASSWORD = "containers123";

const unauthorized = (res: Parameters<RequestHandler>[1]) => {
  res.setHeader("WWW-Authenticate", "Basic realm=\"Logs\"");
  res.status(401).json({ message: "Unauthorized" });
};

const basicAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Basic ")) {
    unauthorized(res);
    return;
  }

  const base64Credentials = header.slice("Basic ".length).trim();

  let decoded: string;
  try {
    decoded = Buffer.from(base64Credentials, "base64").toString("utf-8");
  } catch (error) {
    unauthorized(res);
    return;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    unauthorized(res);
    return;
  }

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  if (username !== DEFAULT_USERNAME || password !== DEFAULT_PASSWORD) {
    unauthorized(res);
    return;
  }

  next();
};

export default basicAuth;
