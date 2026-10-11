import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const manifestDir = new URL("./manifests/", import.meta.url);
const schemaUrl = new URL("../schemas/runtime-manifest.v1.schema.json", import.meta.url);
const manifestSchema = JSON.parse(readFileSync(schemaUrl, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
const validateManifestSchema = ajv.compile(manifestSchema);

export const RUNTIME_MANIFEST_NAMES = Object.freeze(["core", "codex", "antigravity"]);

function displayErrors(errors = []) {
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message || error.keyword}`)
    .join("; ");
}

function assertRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (value.includes("\\")) {
    throw new Error(`${label} must use portable relative path separators`);
  }
  const normalized = posix.normalize(value);
  if (
    value.startsWith("/")
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized !== value.replace(/\/$/, "")
  ) {
    throw new Error(`${label} must be a bounded relative path without escape segments: ${value}`);
  }
  return normalized;
}

function assertRelativeGlob(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")) {
    throw new Error(`${label} must be a bounded relative glob`);
  }
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
  if (Array.isArray(manifest?.sourceRoots)) {
    assertUnique(manifest.sourceRoots, "source root");
  }
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
  // Keep contract-specific fail-closed errors stable instead of leaking Ajv's
  // implementation wording for duplicate ownership declarations.
  assertSemanticDuplicates(manifest);

  if (!validateManifestSchema(manifest)) {
    throw new Error(`runtime manifest schema invalid: ${displayErrors(validateManifestSchema.errors)}`);
  }

  const roots = manifest.sourceRoots.map((root) => assertRelativePath(root, "source root"));
  assertUnique(roots, "source root");

  const outputs = new Set();
  for (const asset of manifest.managedAssets) {
    const source = assertRelativePath(asset.source, "managed asset source");
    const output = assertRelativePath(asset.output, "managed asset output");
    if (!roots.some((root) => isWithin(source, root))) {
      throw new Error(`managed asset source escapes declared source roots: ${source}`);
    }
    if (outputs.has(output)) throw new Error(`managed asset output collision: ${output}`);
    outputs.add(output);
    for (const glob of asset.exclude || []) assertRelativeGlob(glob, `exclude for ${source}`);
  }

  for (const preserved of manifest.preservedProjectPaths) {
    const path = assertRelativePath(preserved, "preserved project path");
    for (const output of outputs) {
      if (pathsOverlap(path, output)) {
        throw new Error(`preserved project path overlaps managed output: ${path} <-> ${output}`);
      }
    }
  }

  for (const input of manifest.generatedInputs) {
    const path = assertRelativePath(input, "generated input");
    if (!roots.some((root) => isWithin(path, root) || isWithin(root, path))) {
      throw new Error(`generated input is outside declared source roots: ${path}`);
    }
  }
  for (const entrypoint of manifest.entrypoints) assertRelativePath(entrypoint, "entrypoint");

  return manifest;
}

export async function loadRuntimeManifest(name) {
  if (!RUNTIME_MANIFEST_NAMES.includes(name)) {
    throw new Error(`Unknown runtime manifest: ${name}`);
  }
  const url = new URL(`${name}.json`, manifestDir);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(url, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Unknown runtime manifest: ${name}`);
    throw error;
  }
  validateRuntimeManifest(manifest);
  if (manifest.runtime !== name) {
    throw new Error(`runtime manifest name mismatch: expected ${name}, received ${manifest.runtime}`);
  }
  return manifest;
}

export function runtimeManifestDirectory() {
  return runtimeDir;
}
