import fs from "fs";
import path from "path";

type EnvRecord = Record<string, string>;

const ROOT_DIR = process.cwd();
const ENV_FILES = [
  path.join(ROOT_DIR, ".env"),
  path.join(ROOT_DIR, ".env.local"),
];

const parseLine = (line: string): [string, string] | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  const value = trimmed.slice(separatorIndex + 1).trim();

  if (!key) {
    return null;
  }

  return [key, value];
};

const loadEnvFile = (filePath: string): EnvRecord => {
  const result: EnvRecord = {};
  const file = fs.readFileSync(filePath, "utf8");
  for (const line of file.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (!entry) {
      continue;
    }

    const [key, value] = entry;
    if (!(key in result)) {
      result[key] = value;
    }
  }
  return result;
};

for (const filePath of ENV_FILES) {
  if (!fs.existsSync(filePath)) {
    continue;
  }

  const values = loadEnvFile(filePath);
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
