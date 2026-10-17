import { readFile } from "node:fs/promises";

const SOURCE_SCHEMA = "orchestra.runtime-image-source.v2";
const SOURCE_KEYS = new Set([
  "schema",
  "version",
  "engineCompatibility",
  "providerAdapterCompatibility",
  "files",
]);
const FILE_KEYS = new Set(["path", "contentBase64"]);

function sourceError(message, fields = {}) {
  const error = new Error(message);
  error.code = "ORCHESTRA_RUNTIME_IMAGE_SOURCE_INVALID";
  Object.assign(error, fields);
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key))
    && [...allowed].every((key) => Object.hasOwn(value, key));
}

function validBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value;
}

function cloneRecord(value, field) {
  if (!isRecord(value)) throw sourceError(`${field} must be an object`, { field });
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw sourceError(`${field} must contain JSON data`, { field });
  }
}

export async function loadRuntimeImageSource(sourcePath) {
  if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) {
    throw sourceError("runtime image source path is required");
  }

  let decoded;
  try {
    decoded = JSON.parse(await readFile(sourcePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw sourceError(`runtime image source does not exist: ${sourcePath}`, { sourcePath });
    }
    if (error?.code === "ORCHESTRA_RUNTIME_IMAGE_SOURCE_INVALID") throw error;
    throw sourceError(`runtime image source is unreadable or invalid JSON: ${sourcePath}`, { sourcePath });
  }

  if (!isRecord(decoded) || !hasExactKeys(decoded, SOURCE_KEYS) || decoded.schema !== SOURCE_SCHEMA) {
    throw sourceError("runtime image source has an invalid top-level contract");
  }
  if (typeof decoded.version !== "string" || decoded.version.length === 0) {
    throw sourceError("runtime image source version is required", { field: "version" });
  }
  if (!Array.isArray(decoded.files) || decoded.files.length === 0) {
    throw sourceError("runtime image source files must be a non-empty array", { field: "files" });
  }

  const files = Object.create(null);
  for (const entry of decoded.files) {
    if (!isRecord(entry) || !hasExactKeys(entry, FILE_KEYS)
      || typeof entry.path !== "string" || entry.path.length === 0
      || !validBase64(entry.contentBase64)
      || Object.hasOwn(files, entry.path)) {
      throw sourceError("runtime image source contains an invalid file entry", { filePath: entry?.path ?? null });
    }
    files[entry.path] = Buffer.from(entry.contentBase64, "base64");
  }

  return Object.freeze({
    version: decoded.version,
    engineCompatibility: cloneRecord(decoded.engineCompatibility, "engineCompatibility"),
    providerAdapterCompatibility: cloneRecord(
      decoded.providerAdapterCompatibility,
      "providerAdapterCompatibility",
    ),
    files,
  });
}
