import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { ensureProjectStateIgnored } from "./project-state-ignore.mjs";
import { validateRuntimeManifest } from "./manifest-loader.mjs";

const METADATA_SCHEMA = "orchestra.project-runtime.v2";
const BACKUP_SCHEMA = "orchestra.project-runtime-backup.v2";
const EVENT_SCHEMA = "orchestra.project-runtime-event.v2";

function portable(path) {
  return String(path).split(sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key]) ]));
  }
  return value;
}

function manifestHash(manifest) {
  return sha256(JSON.stringify(stableValue(manifest)));
}

function metadataPath(targetDir, runtime) {
  return join(targetDir, ".orchestra", "state", "runtimes", `${runtime}.json`);
}

function managementRoot(targetDir, runtime) {
  return join(targetDir, ".orchestra", "state", "runtime-management", runtime);
}

function backupsRoot(targetDir, runtime) {
  return join(managementRoot(targetDir, runtime), "backups");
}

function historyPath(targetDir, runtime) {
  return join(managementRoot(targetDir, runtime), "history.jsonl");
}

function assertBackupId(value) {
  const backupId = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(backupId) || backupId === "." || backupId === "..") {
    const error = new Error(`INVALID_BACKUP_ID: ${backupId || "EMPTY"}`);
    error.code = "INVALID_BACKUP_ID";
    throw error;
  }
  return backupId;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

function managedRoots(manifest) {
  const outputs = [...new Set(manifest.managedAssets.map((asset) => asset.output))]
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return outputs.filter((candidate, index) => !outputs.slice(0, index).some(
    (parent) => candidate === parent || candidate.startsWith(`${parent}/`),
  ));
}

async function collectEntry(baseDir, relPath, entries) {
  const full = join(baseDir, relPath);
  if (!await exists(full)) {
    entries.push({ path: portable(relPath), type: "missing", digest: null, target: null });
    return;
  }
  const info = await lstat(full);
  if (info.isSymbolicLink()) {
    const target = await readlink(full);
    entries.push({ path: portable(relPath), type: "symlink", digest: sha256(`symlink:${target}`), target });
    return;
  }
  if (info.isFile()) {
    entries.push({ path: portable(relPath), type: "file", digest: sha256(await readFile(full)), target: null });
    return;
  }
  if (!info.isDirectory()) {
    entries.push({ path: portable(relPath), type: "other", digest: sha256(String(info.mode)), target: null });
    return;
  }
  entries.push({ path: portable(relPath), type: "dir", digest: null, target: null });
  const children = await readdir(full);
  children.sort((a, b) => a.localeCompare(b));
  for (const child of children) await collectEntry(baseDir, join(relPath, child), entries);
}

async function snapshot(baseDir, roots) {
  const entries = [];
  for (const root of roots) await collectEntry(baseDir, root, entries);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    entries,
    hash: sha256(JSON.stringify(entries.map(({ path, type, digest, target }) => ({ path, type, digest, target })))),
  };
}

function diffSnapshots(source, target) {
  const sourceMap = new Map(source.entries.map((entry) => [entry.path, entry]));
  const targetMap = new Map(target.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...sourceMap.keys(), ...targetMap.keys()])].sort();
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const path of paths) {
    const a = sourceMap.get(path);
    const b = targetMap.get(path);
    if (!b || b.type === "missing") {
      if (a && a.type !== "missing") added.push(path);
    } else if (!a || a.type === "missing") {
      if (b.type !== "missing") removed.push(path);
    } else if (a.type !== b.type || a.digest !== b.digest || a.target !== b.target) {
      changed.push(path);
    } else {
      unchanged.push(path);
    }
  }
  return { clean: added.length === 0 && removed.length === 0 && changed.length === 0, added, removed, changed, unchanged };
}

async function ensureTarget(targetDir) {
  const info = await stat(targetDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`TARGET_NOT_FOUND: ${targetDir}`);
}

async function ensurePreservedDirs(targetDir, manifest) {
  for (const rel of manifest.preservedProjectPaths) await mkdir(join(targetDir, rel), { recursive: true });
  await mkdir(dirname(metadataPath(targetDir, manifest.runtime)), { recursive: true });
  ensureProjectStateIgnored(targetDir);
}

async function copyManagedRoots({ sourceDir, targetDir, roots }) {
  for (const rel of roots) {
    const source = join(sourceDir, rel);
    if (!await exists(source)) throw new Error(`BUILT_RUNTIME_PATH_MISSING: ${rel}`);
    const target = join(targetDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true, dereference: false, preserveTimestamps: true });
  }
}

async function removeManagedRoots(targetDir, roots) {
  for (const rel of roots) await rm(join(targetDir, rel), { recursive: true, force: true });
}

async function appendHistory(targetDir, runtime, event) {
  const path = historyPath(targetDir, runtime);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ schema: EVENT_SCHEMA, observedAt: new Date().toISOString(), ...event })}\n`);
}

async function writeMetadata({ targetDir, manifest, builtSnapshot, operation, previousBackupId = null, installedAt = null }) {
  const path = metadataPath(targetDir, manifest.runtime);
  const existing = await readJson(path, null);
  const now = new Date().toISOString();
  const metadata = {
    schema: METADATA_SCHEMA,
    runtime: manifest.runtime,
    version: manifest.version,
    manifestHash: manifestHash(manifest),
    runtimeHash: builtSnapshot.hash,
    managedPaths: managedRoots(manifest),
    preservedProjectPaths: [...manifest.preservedProjectPaths],
    installedAt: installedAt || existing?.installedAt || now,
    updatedAt: now,
    lastOperation: operation,
    previousBackupId,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

async function assertQuiescent(targetDir, adapter, force) {
  if (!adapter?.checkQuiescence) return { safe: true, reason: "NO_PROVIDER_QUIESCENCE_ADAPTER" };
  const result = await adapter.checkQuiescence(targetDir);
  if (!result?.safe && !force) {
    const error = new Error(`RUNTIME_NOT_QUIESCENT: ${result?.reason || "UNKNOWN"}`);
    error.code = "RUNTIME_NOT_QUIESCENT";
    error.quiescence = result;
    throw error;
  }
  return result;
}

async function createBackup({ targetDir, manifest, reason }) {
  const roots = managedRoots(manifest);
  const current = await snapshot(targetDir, roots);
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  let backupId = `${stamp}-${current.hash.slice(0, 10)}`;
  let suffix = 1;
  while (await exists(join(backupsRoot(targetDir, manifest.runtime), backupId))) {
    backupId = `${stamp}-${current.hash.slice(0, 10)}-${suffix++}`;
  }
  const dir = join(backupsRoot(targetDir, manifest.runtime), backupId);
  await mkdir(dir, { recursive: true });
  for (const rel of roots) {
    const source = join(targetDir, rel);
    if (!await exists(source)) continue;
    const target = join(dir, "runtime", rel);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true, dereference: false, preserveTimestamps: true });
  }
  const runtimeMetadata = await readJson(metadataPath(targetDir, manifest.runtime), null);
  await writeFile(join(dir, "backup.json"), `${JSON.stringify({
    schema: BACKUP_SCHEMA,
    backupId,
    createdAt: new Date().toISOString(),
    reason,
    runtimeHash: current.hash,
    runtimeMetadata,
    managedPaths: roots,
  }, null, 2)}\n`);
  return { backupId, dir, runtimeHash: current.hash };
}

export async function inspectProjectRuntime({ targetDir, runtimeManifest, builtRuntime }) {
  validateRuntimeManifest(runtimeManifest);
  await ensureTarget(targetDir);
  const roots = managedRoots(runtimeManifest);
  const source = await snapshot(resolve(builtRuntime), roots);
  const target = await snapshot(resolve(targetDir), roots);
  const diff = diffSnapshots(source, target);
  const metadata = await readJson(metadataPath(targetDir, runtimeManifest.runtime), null);
  const installed = roots.some((rel) => target.entries.some((entry) => entry.path === rel && entry.type !== "missing"));
  const metadataCurrent = Boolean(metadata)
    && metadata.schema === METADATA_SCHEMA
    && metadata.runtime === runtimeManifest.runtime
    && metadata.version === runtimeManifest.version
    && metadata.manifestHash === manifestHash(runtimeManifest)
    && metadata.runtimeHash === source.hash;
  return {
    runtime: runtimeManifest.runtime,
    installed,
    managed: Boolean(metadata),
    clean: diff.clean && metadataCurrent,
    diff,
    metadata,
    sourceHash: source.hash,
    targetHash: target.hash,
    metadataCurrent,
  };
}

export async function installProjectRuntime({ targetDir, runtimeManifest, builtRuntime, adapter = null }) {
  validateRuntimeManifest(runtimeManifest);
  await ensureTarget(targetDir);
  const roots = managedRoots(runtimeManifest);
  const occupied = [];
  for (const rel of roots) if (await exists(join(targetDir, rel))) occupied.push(rel);
  if (occupied.length > 0) {
    const error = new Error(`RUNTIME_INSTALL_CONFLICT: ${occupied.join(", ")}`);
    error.code = "RUNTIME_INSTALL_CONFLICT";
    error.paths = occupied;
    throw error;
  }
  await ensurePreservedDirs(targetDir, runtimeManifest);
  await copyManagedRoots({ sourceDir: resolve(builtRuntime), targetDir, roots });
  if (adapter?.afterInstall) await adapter.afterInstall(targetDir, runtimeManifest);
  const builtSnapshot = await snapshot(resolve(builtRuntime), roots);
  const metadata = await writeMetadata({ targetDir, manifest: runtimeManifest, builtSnapshot, operation: "install" });
  await appendHistory(targetDir, runtimeManifest.runtime, { operation: "install", runtimeHash: builtSnapshot.hash });
  return { operation: "install", changed: true, metadata };
}

export async function updateProjectRuntime({ targetDir, runtimeManifest, builtRuntime, adapter = null, dryRun = false, force = false }) {
  validateRuntimeManifest(runtimeManifest);
  const inspection = await inspectProjectRuntime({ targetDir, runtimeManifest, builtRuntime });
  if (!inspection.installed) {
    if (dryRun) return { operation: "install", changed: true, dryRun: true, inspection };
    return installProjectRuntime({ targetDir, runtimeManifest, builtRuntime, adapter });
  }
  const runtimeChanged = !inspection.diff.clean;
  const metadataChanged = !inspection.metadataCurrent;
  if (!runtimeChanged && !metadataChanged) return { operation: "noop", changed: false, dryRun, inspection };
  if (dryRun) return { operation: inspection.managed ? "update" : "adopt", changed: true, dryRun: true, runtimeChanged, metadataChanged, inspection };

  await assertQuiescent(targetDir, adapter, force);
  await ensurePreservedDirs(targetDir, runtimeManifest);
  let backup = null;
  if (runtimeChanged || !inspection.managed) backup = await createBackup({ targetDir, manifest: runtimeManifest, reason: inspection.managed ? "update" : "adopt" });
  const roots = managedRoots(runtimeManifest);
  if (runtimeChanged) {
    await removeManagedRoots(targetDir, roots);
    await copyManagedRoots({ sourceDir: resolve(builtRuntime), targetDir, roots });
    if (adapter?.afterInstall) await adapter.afterInstall(targetDir, runtimeManifest);
  }
  const builtSnapshot = await snapshot(resolve(builtRuntime), roots);
  const operation = runtimeChanged ? (inspection.managed ? "update" : "adopt") : "metadata-sync";
  const metadata = await writeMetadata({
    targetDir,
    manifest: runtimeManifest,
    builtSnapshot,
    operation,
    previousBackupId: backup?.backupId || inspection.metadata?.previousBackupId || null,
    installedAt: inspection.metadata?.installedAt || null,
  });
  await appendHistory(targetDir, runtimeManifest.runtime, { operation, backupId: backup?.backupId || null, runtimeHash: builtSnapshot.hash });
  return { operation, changed: true, runtimeChanged, metadataChanged, backupId: backup?.backupId || null, metadata };
}

export async function rollbackProjectRuntime({ targetDir, runtimeManifest, backupId, adapter = null, force = false }) {
  validateRuntimeManifest(runtimeManifest);
  await ensureTarget(targetDir);
  const safeBackupId = assertBackupId(backupId);
  await assertQuiescent(targetDir, adapter, force);
  const backupDir = join(backupsRoot(targetDir, runtimeManifest.runtime), safeBackupId);
  const backup = await readJson(join(backupDir, "backup.json"), null);
  if (!backup || backup.schema !== BACKUP_SCHEMA || backup.backupId !== safeBackupId) {
    throw new Error(`RUNTIME_BACKUP_NOT_FOUND: ${safeBackupId}`);
  }

  const safetyBackup = await createBackup({ targetDir, manifest: runtimeManifest, reason: `pre-rollback:${safeBackupId}` });
  const roots = managedRoots(runtimeManifest);
  await removeManagedRoots(targetDir, roots);
  for (const rel of roots) {
    const source = join(backupDir, "runtime", rel);
    if (!await exists(source)) continue;
    const target = join(targetDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true, dereference: false, preserveTimestamps: true });
  }
  if (adapter?.afterInstall) await adapter.afterInstall(targetDir, runtimeManifest);
  await ensurePreservedDirs(targetDir, runtimeManifest);
  const restored = await snapshot(targetDir, roots);
  const previous = backup.runtimeMetadata;
  const metadata = {
    schema: METADATA_SCHEMA,
    runtime: runtimeManifest.runtime,
    version: previous?.version || runtimeManifest.version,
    manifestHash: previous?.manifestHash || manifestHash(runtimeManifest),
    runtimeHash: restored.hash,
    managedPaths: roots,
    preservedProjectPaths: [...runtimeManifest.preservedProjectPaths],
    installedAt: previous?.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastOperation: "rollback",
    previousBackupId: safetyBackup.backupId,
  };
  await writeFile(metadataPath(targetDir, runtimeManifest.runtime), `${JSON.stringify(metadata, null, 2)}\n`);
  await appendHistory(targetDir, runtimeManifest.runtime, { operation: "rollback", backupId: safeBackupId, safetyBackupId: safetyBackup.backupId, runtimeHash: restored.hash });
  return { operation: "rollback", changed: true, backupId: safeBackupId, safetyBackupId: safetyBackup.backupId, metadata };
}

export const PROJECT_RUNTIME_METADATA_SCHEMA = METADATA_SCHEMA;
