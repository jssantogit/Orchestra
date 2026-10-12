import { readFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const manifestDir = new URL("./manifests/", import.meta.url);
const MANIFEST_SCHEMA = "orchestra.runtime-manifest.v1";
const MANIFEST_KEYS = Object.freeze([
  "schema",
  "runtime",
  "version",
  "sourceRoots",
  "managedAssets",
  "preservedProjectPaths",
  "generatedInputs",
  "entrypoints",
  "healthChecks",
]);
const MANAGED_ASSET_KEYS = Object.freeze(["type", "source", "output", "exclude"]);
const MANAGED_ASSET_TYPES = new Set(["file", "tree", "symlink"]);
const DRIVE_ABSOLUTE = /^[A-Za-z]:\//;

export const RUNTIME_MANIFEST_NAMES = Object.freeze(["core", "codex", "antigravity"]);

function schemaError(message) {
  throw new Error(`runtime manifest schema invalid: ${message}`);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    schemaError(`${label} must be an object`);
  }
}

function assertAllowedKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) schemaError(`${label} has unexpected property: ${key}`);
  }
}

function assertRequiredKeys(value, required, label) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      schemaError(`${label} is missing required property: ${key}`);
    }
  }
}

function assertNonEmptyString(value, label, pattern = null) {
  if (typeof value !== "string" || value.length === 0) {
    schemaError(`${label} must be a non-empty string`);
  }
  if (pattern && !pattern.test(value)) {
    schemaError(`${label} has invalid format: ${value}`);
  }
}

function assertStringArray(value, label, { minItems = 0, unique = false } = {}) {
  if (!Array.isArray(value)) schemaError(`${label} must be an array`);
  if (value.length < minItems) schemaError(`${label} must contain at least ${minItems} item(s)`);
  for (let index = 0; index < value.length; index += 1) {
    assertNonEmptyString(value[index], `${label}[${index}]`);
  }
  if (unique && new Set(value).size !== value.length) {
    schemaError(`${label} must contain unique items`);
  }
}

function validateManifestShape(manifest) {
  assertObject(manifest, "manifest");
  assertAllowedKeys(manifest, MANIFEST_KEYS, "manifest");
  assertRequiredKeys(manifest, MANIFEST_KEYS, "manifest");

  if (manifest.schema !== MANIFEST_SCHEMA) schemaError(`schema must equal ${MANIFEST_SCHEMA}`);
  assertNonEmptyString(manifest.runtime, "runtime", /^[a-z0-9][a-z0-9-]*$/);
  assertNonEmptyString(manifest.version, "version");
  assertStringArray(manifest.sourceRoots, "sourceRoots", { minItems: 1, unique: true });

  if (!Array.isArray(manifest.managedAssets)) schemaError("managedAssets must be an array");
  for (let index = 0; index < manifest.managedAssets.length; index += 1) {
    const asset = manifest.managedAssets[index];
    const label = `managedAssets[${index}]`;
    assertObject(asset, label);
    assertAllowedKeys(asset, MANAGED_ASSET_KEYS, label);
    assertRequiredKeys(asset, ["type", "source", "output"], label);
    if (!MANAGED_ASSET_TYPES.has(asset.type)) schemaError(`${label}.type must be one of file, tree, symlink`);
    assertNonEmptyString(asset.source, `${label}.source`);
    assertNonEmptyString(asset.output, `${label}.output`);
    if (Object.prototype.hasOwnProperty.call(asset, "exclude")) assertStringArray(asset.exclude, `${label}.exclude`, { unique: true });
  }

  assertStringArray(manifest.preservedProjectPaths, "preservedProjectPaths", { unique: true });
  assertStringArray(manifest.generatedInputs, "generatedInputs", { unique: true });
  assertStringArray(manifest.entrypoints, "entrypoints", { unique: true });
  assertStringArray(manifest.healthChecks, "healthChecks", { unique: true });
}

function assertRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty relative path`);
  if (value.includes("\\")) throw new Error(`${label} must use portable relative path separators`);
  const normalized = posix.normalize(value);
  if (
    value.startsWith("/")
    || DRIVE_ABSOLUTE.test(value)
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized !== value.replace(/\/$/, "")
  ) throw new Error(`${label} must be a bounded relative path without escape segments: ${value}`);
  return normalized;
}

function assertRelativeGlob(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.startsWith("/")
    || DRIVE_ABSOLUTE.test(value)
    || value.includes("\\")
  ) throw new Error(`${label} must be a bounded relative glob`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`${label} glob may not escape its source root: ${value}`);
  }
}

function isWithin(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function pathsOverlap(a, b) {
  return isWithin(a, b) || isWithin(b, a);
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function assertSemanticDuplicates(manifest) {
  if (Array.isArray(manifest?.sourceRoots)) assertUnique(manifest.sourceRoots, "source root");
  if (Array.isArray(manifest?.managedAssets)) {
    const outputs = new Set();
    for (const asset of manifest.managedAssets) {
      if (typeof asset?.output !== "string") continue;
      if (outputs.has(asset.output)) throw new Error(`managed asset output collision: ${asset.output}`);
      outputs.add(asset.output);
    }
  }
}

export function validateRuntimeManifest(manifest) {
  assertSemanticDuplicates(manifest);
  validateManifestShape(manifest);

  const roots = manifest.sourceRoots.map((root) => assertRelativePath(root, "source root"));
  assertUnique(roots, "source root");

  const outputs = new Set();
  for (const asset of manifest.managedAssets) {
    const source = assertRelativePath(asset.source, "managed asset source");
    const output = assertRelativePath(asset.output, "managed asset output");
    if (!roots.some((root) => isWithin(source, root))) throw new Error(`managed asset source escapes declared source roots: ${source}`);
    if (outputs.has(output)) throw new Error(`managed asset output collision: ${output}`);
    outputs.add(output);
    for (const glob of asset.exclude || []) assertRelativeGlob(glob, `exclude for ${source}`);
  }

  for (const preserved of manifest.preservedProjectPaths) {
    const path = assertRelativePath(preserved, "preserved project path");
    for (const output of outputs) {
      if (pathsOverlap(path, output)) throw new Error(`preserved project path overlaps managed output: ${path} <-> ${output}`);
    }
  }

  for (const input of manifest.generatedInputs) {
    const path = assertRelativePath(input, "generated input");
    if (!roots.some((root) => isWithin(path, root) || isWithin(root, path))) throw new Error(`generated input is outside declared source roots: ${path}`);
  }
  for (const entrypoint of manifest.entrypoints) assertRelativePath(entrypoint, "entrypoint");

  return manifest;
}

export async function loadRuntimeManifest(name) {
  if (!RUNTIME_MANIFEST_NAMES.includes(name)) throw new Error(`Unknown runtime manifest: ${name}`);
  const url = new URL(`${name}.json`, manifestDir);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(url, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Unknown runtime manifest: ${name}`);
    throw error;
  }
  validateRuntimeManifest(manifest);
  if (manifest.runtime !== name) throw new Error(`runtime manifest name mismatch: expected ${name}, received ${manifest.runtime}`);
  return manifest;
}

export function runtimeManifestDirectory() {
  return runtimeDir;
}
