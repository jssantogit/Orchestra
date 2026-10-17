import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const PARALLEL_GROUP_ROOT = ".orchestra/state/delegation/parallel-groups";
const RECOGNIZED_ROOTS = Object.freeze([
  Object.freeze({ root: PARALLEL_GROUP_ROOT, mode: "PARALLEL_GROUP" }),
  Object.freeze({ root: ".orchestra/state/delegation/artifacts", mode: "PRIVATE_ARTIFACT" }),
  Object.freeze({ root: ".orchestra/state/delegation/composite-artifacts", mode: "PRIVATE_ARTIFACT" }),
  Object.freeze({ root: ".orchestra/state/delegations", mode: "TRANSIENT_STATE" }),
  Object.freeze({ root: ".orchestra/state/work-lease", mode: "TRANSIENT_STATE" }),
  Object.freeze({ root: ".orchestra/state/session-bindings", mode: "TRANSIENT_STATE" }),
  Object.freeze({ root: ".orchestra/state/candidates", mode: "DURABLE_STATE" }),
  Object.freeze({ root: ".orchestra/state/evidence", mode: "DURABLE_STATE" }),
  Object.freeze({ root: ".orchestra/state/continuation", mode: "DURABLE_STATE" }),
  Object.freeze({ root: ".codex/orchestra-state", mode: "PROVIDER_STATE" }),
  Object.freeze({ root: ".codex/astra-orchestra", mode: "MANAGED_RUNTIME" }),
  Object.freeze({ root: ".agents/orchestra-runtime.json", mode: "MANAGED_RUNTIME_FILE" }),
  Object.freeze({ root: ".agents/hooks.json", mode: "MANAGED_RUNTIME_FILE" }),
  Object.freeze({ root: ".agents/hooks", mode: "MANAGED_RUNTIME" }),
  Object.freeze({ root: ".agents/runtime-management", mode: "MANAGED_RUNTIME" }),
  Object.freeze({ root: ".agents/semantic", mode: "MANAGED_RUNTIME" }),
  Object.freeze({ root: ".agents/skills", mode: "MANAGED_RUNTIME" }),
  Object.freeze({ root: ".agents/state", mode: "PROVIDER_STATE" }),
]);

function normalizePath(path) {
  return path.split(sep).join("/");
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function schemaVersion(schema, explicitVersion) {
  if (Number.isInteger(explicitVersion) && explicitVersion >= 1) return explicitVersion;
  if (typeof schema !== "string") return null;
  const match = schema.match(/\.v([1-9][0-9]*)$/);
  return match ? Number(match[1]) : null;
}

function classify(mode, relativePath) {
  if (mode === "PARALLEL_GROUP") {
    const rel = relativePath.slice(`${PARALLEL_GROUP_ROOT}/`.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\/group\.json$/.test(rel)) return null;
    return Object.freeze({
      category: "TRANSIENT_PARALLEL_GROUP",
      dispositionBasis: "TRANSIENT_STATE",
      private: false,
      expectsSchema: true,
    });
  }
  if (mode === "PRIVATE_ARTIFACT") {
    return Object.freeze({
      category: "PRIVATE_PROJECT_ARTIFACT",
      dispositionBasis: "PRIVATE_ARCHIVE",
      private: true,
      expectsSchema: false,
    });
  }
  if (mode === "TRANSIENT_STATE") {
    return Object.freeze({
      category: "TRANSIENT_LEGACY_STATE",
      dispositionBasis: "TRANSIENT_STATE",
      private: false,
      expectsSchema: false,
    });
  }
  if (mode === "DURABLE_STATE") {
    return Object.freeze({
      category: "DURABLE_LEGACY_STATE",
      dispositionBasis: "DURABLE_STATE",
      private: false,
      expectsSchema: false,
    });
  }
  if (mode === "PROVIDER_STATE") {
    return Object.freeze({
      category: "PROVIDER_LEGACY_STATE",
      dispositionBasis: "PROVIDER_STATE",
      private: false,
      expectsSchema: false,
    });
  }
  if (mode === "MANAGED_RUNTIME" || mode === "MANAGED_RUNTIME_FILE") {
    return Object.freeze({
      category: "MANAGED_RUNTIME",
      dispositionBasis: "MANAGED_RUNTIME_COPY",
      private: false,
      expectsSchema: false,
    });
  }
  return null;
}

function parseMetadata(bytes, path, expectsSchema) {
  if (!path.endsWith(".json")) {
    return Object.freeze({ schema: null, version: null, integrity: "OPAQUE_MANAGED_FILE" });
  }
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return Object.freeze({ schema: null, version: null, integrity: "MALFORMED_JSON" });
  }
  const schema = typeof record?.schema === "string" && record.schema.length > 0 ? record.schema : null;
  const version = schemaVersion(schema, record?.version);
  if (expectsSchema && schema === null) {
    return Object.freeze({ schema: null, version: null, integrity: "MALFORMED_SCHEMA" });
  }
  if (schema !== null && version === null) {
    return Object.freeze({ schema, version: null, integrity: "MALFORMED_SCHEMA" });
  }
  return Object.freeze({ schema, version, integrity: "PARSED" });
}

function issue(code, path, details = {}) {
  return Object.freeze({ code, path, ...details });
}

async function maybeStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function inventoryLegacyProject({ workspace } = {}) {
  if (typeof workspace !== "string" || workspace.trim().length === 0) {
    return Object.freeze({ ok: false, code: "MIGRATION_WORKSPACE_INVALID", entries: Object.freeze([]), issues: Object.freeze([]) });
  }

  let workspaceRoot;
  try {
    workspaceRoot = await realpath(resolve(workspace));
  } catch (error) {
    return Object.freeze({
      ok: false,
      code: "MIGRATION_WORKSPACE_UNREADABLE",
      entries: Object.freeze([]),
      issues: Object.freeze([issue("MIGRATION_WORKSPACE_UNREADABLE", ".", { sourceCode: error?.code ?? null })]),
    });
  }

  const entries = [];
  const issues = [];
  const seenFiles = new Set();
  const scannedRoots = new Set();

  async function inspectFile(absolutePath, mode) {
    const path = normalizePath(relative(workspaceRoot, absolutePath));
    if (!isInside(workspaceRoot, absolutePath)) {
      issues.push(issue("MIGRATION_PATH_ESCAPE_BLOCKED", path));
      return;
    }
    if (seenFiles.has(path)) return;
    const classification = classify(mode, path);
    if (classification === null) return;

    let bytes;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      issues.push(issue("MIGRATION_READ_FAILED", path, { sourceCode: error?.code ?? null }));
      return;
    }
    const metadata = parseMetadata(bytes, path, classification.expectsSchema);
    entries.push(Object.freeze({
      path,
      category: classification.category,
      schema: metadata.schema,
      version: metadata.version,
      digest: digest(bytes),
      integrity: metadata.integrity,
      dispositionBasis: metadata.integrity === "MALFORMED_JSON" || metadata.integrity === "MALFORMED_SCHEMA"
        ? "UNSUPPORTED_OR_MALFORMED"
        : classification.dispositionBasis,
      private: classification.private,
    }));
    seenFiles.add(path);
  }

  async function walk(absolutePath, mode) {
    let stat;
    try {
      stat = await maybeStat(absolutePath);
    } catch (error) {
      const path = normalizePath(relative(workspaceRoot, absolutePath));
      issues.push(issue("MIGRATION_READ_FAILED", path, { sourceCode: error?.code ?? null }));
      return;
    }
    if (stat === null) return;

    const path = normalizePath(relative(workspaceRoot, absolutePath));
    if (!isInside(workspaceRoot, absolutePath)) {
      issues.push(issue("MIGRATION_PATH_ESCAPE_BLOCKED", path));
      return;
    }
    if (stat.isSymbolicLink()) {
      issues.push(issue("MIGRATION_PATH_ESCAPE_BLOCKED", path));
      return;
    }
    if (stat.isFile()) {
      await inspectFile(absolutePath, mode);
      return;
    }
    if (!stat.isDirectory()) return;

    let names;
    try {
      names = (await readdir(absolutePath)).sort((left, right) => left.localeCompare(right, "en"));
    } catch (error) {
      issues.push(issue("MIGRATION_READ_FAILED", path, { sourceCode: error?.code ?? null }));
      return;
    }
    for (const name of names) await walk(join(absolutePath, name), mode);
  }

  for (const descriptor of RECOGNIZED_ROOTS) {
    if (scannedRoots.has(descriptor.root)) continue;
    scannedRoots.add(descriptor.root);
    await walk(join(workspaceRoot, ...descriptor.root.split("/")), descriptor.mode);
  }

  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  issues.sort((left, right) => left.path.localeCompare(right.path, "en") || left.code.localeCompare(right.code, "en"));

  return Object.freeze({
    ok: issues.length === 0,
    code: issues.length === 0 ? "MIGRATION_INVENTORY_READY" : "MIGRATION_INVENTORY_BLOCKED",
    workspaceRoot,
    entries: Object.freeze(entries),
    issues: Object.freeze(issues),
  });
}
