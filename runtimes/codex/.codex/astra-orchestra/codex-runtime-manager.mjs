import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const CODEX_PROJECT_RUNTIME_SCHEMA = "orchestra.codex-project-runtime.v1";
export const CODEX_PROJECT_RUNTIME_MANAGER_VERSION = 2;

export const CODEX_MANAGED_RUNTIME_PATHS = Object.freeze([
  ".codex/config.toml",
  ".codex/hooks.json",
  ".codex/agents",
  ".codex/astra-orchestra",
]);

export const CODEX_PRESERVED_PROJECT_PATHS = Object.freeze([
  ".codex/orchestra-state",
  ".codex/orchestra-telemetry",
  ".codex/orchestra-artifacts",
  ".codex/orchestra-semantic",
  ".codex/runtime-management",
]);

const QUIESCENT_STATES = new Set(["DONE", "BLOCKED", "HUMAN_GATE"]);
const ACTIVE_STATES = new Set([
  "CLASSIFIED", "DIRECT_ACTION", "PLANNED", "DELEGATED", "EXECUTING",
  "EVIDENCE_READY", "CI_WAIT", "ACCEPTANCE", "INTEGRATING", "CRITICAL_REVIEW",
]);

function nowIso() {
  return new Date().toISOString();
}

function portable(path) {
  return String(path).split(sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000 });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || "").trim() || null;
}

function ensureTargetExists(targetDir) {
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    throw new Error("TARGET_NOT_FOUND: " + targetDir);
  }
}

function metadataPath(targetDir) {
  return join(targetDir, ".codex", "orchestra-runtime.json");
}

function managementRoot(targetDir) {
  return join(targetDir, ".codex", "runtime-management");
}

function backupsRoot(targetDir) {
  return join(managementRoot(targetDir), "backups");
}

function historyPath(targetDir) {
  return join(managementRoot(targetDir), "history.jsonl");
}

function ensureProjectStateDirs(targetDir) {
  const dirs = [
    ".codex/orchestra-state",
    ".codex/orchestra-state/dream",
    ".codex/orchestra-telemetry",
    ".codex/orchestra-artifacts",
    ".codex/orchestra-artifacts/outputs",
    ".codex/orchestra-semantic",
    ".codex/runtime-management/backups",
  ];
  for (const rel of dirs) mkdirSync(join(targetDir, rel), { recursive: true });

  const keepFiles = [
    ".codex/orchestra-state/.gitkeep",
    ".codex/orchestra-state/dream/.gitkeep",
    ".codex/orchestra-telemetry/.gitkeep",
    ".codex/orchestra-artifacts/.gitkeep",
    ".codex/orchestra-artifacts/outputs/.gitkeep",
    ".codex/orchestra-semantic/.gitkeep",
  ];
  for (const rel of keepFiles) {
    const path = join(targetDir, rel);
    if (!existsSync(path)) writeFileSync(path, "");
  }
}

function copyPath(sourceBase, targetBase, relPath) {
  const source = join(sourceBase, relPath);
  const target = join(targetBase, relPath);
  if (!existsSync(source)) throw new Error("SOURCE_RUNTIME_PATH_MISSING: " + relPath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
}

function removeManagedRuntime(targetDir) {
  for (const rel of CODEX_MANAGED_RUNTIME_PATHS) {
    rmSync(join(targetDir, rel), { recursive: true, force: true });
  }
}

function installManagedRuntime(sourceRuntimeRoot, targetDir) {
  for (const rel of CODEX_MANAGED_RUNTIME_PATHS) {
    copyPath(sourceRuntimeRoot, targetDir, rel);
  }
  ensureProjectStateDirs(targetDir);
}

function collectPathEntries(baseDir, relPath, entries) {
  const full = join(baseDir, relPath);
  if (!existsSync(full)) {
    entries.push({ path: portable(relPath), type: "missing", digest: null });
    return;
  }
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) {
    entries.push({ path: portable(relPath), type: "symlink", digest: sha256(readlinkSync(full)) });
    return;
  }
  if (stat.isDirectory()) {
    const children = readdirSync(full).sort();
    if (children.length === 0) entries.push({ path: portable(relPath), type: "directory", digest: sha256("") });
    for (const child of children) collectPathEntries(baseDir, join(relPath, child), entries);
    return;
  }
  const bytes = readFileSync(full);
  entries.push({
    path: portable(relPath),
    type: "file",
    size: bytes.length,
    digest: sha256(bytes),
  });
}

export function buildCodexRuntimeManifest(baseDir) {
  const entries = [];
  for (const rel of CODEX_MANAGED_RUNTIME_PATHS) collectPathEntries(baseDir, rel, entries);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schema: "orchestra.codex-runtime-manifest.v1",
    managedPaths: [...CODEX_MANAGED_RUNTIME_PATHS],
    entries,
    hash: sha256(JSON.stringify(entries)),
  };
}

export function diffCodexRuntimeManifests(source, target) {
  const sourceMap = new Map((source?.entries || []).map((item) => [item.path, item]));
  const targetMap = new Map((target?.entries || []).map((item) => [item.path, item]));
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [path, src] of sourceMap) {
    const dst = targetMap.get(path);
    if (!dst || dst.type === "missing") added.push(path);
    else if (src.type !== dst.type || src.digest !== dst.digest || src.size !== dst.size) changed.push(path);
    else unchanged.push(path);
  }
  for (const [path, dst] of targetMap) {
    if (dst.type !== "missing" && !sourceMap.has(path)) removed.push(path);
  }
  return {
    clean: added.length === 0 && removed.length === 0 && changed.length === 0,
    added, removed, changed, unchanged,
  };
}

export function getCodexSourceRuntimeDescriptor(sourceRuntimeRoot) {
  const source = resolve(sourceRuntimeRoot);
  const orchestraRoot = resolve(source, "..", "..");
  const pkg = readJson(join(orchestraRoot, "package.json"), {});
  const manifest = buildCodexRuntimeManifest(source);
  return {
    sourceRuntimeRoot: source,
    orchestraRoot,
    orchestraVersion: pkg.version || null,
    sourceCommit: git(orchestraRoot, ["rev-parse", "HEAD"]),
    sourceBranch: git(orchestraRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    manifest,
  };
}

export function readInstalledCodexRuntimeMetadata(targetDir) {
  return readJson(metadataPath(resolve(targetDir)), null);
}

function writeMetadata(targetDir, source, {
  operation,
  previousBackupId = null,
  installedAt = null,
} = {}) {
  mkdirSync(join(targetDir, ".codex"), { recursive: true });
  const previous = readInstalledCodexRuntimeMetadata(targetDir);
  const metadata = {
    schema: CODEX_PROJECT_RUNTIME_SCHEMA,
    managerVersion: CODEX_PROJECT_RUNTIME_MANAGER_VERSION,
    runtime: "CODEX",
    orchestraVersion: source.orchestraVersion,
    sourceCommit: source.sourceCommit,
    sourceBranch: source.sourceBranch,
    manifestHash: source.manifest.hash,
    installedAt: installedAt || previous?.installedAt || nowIso(),
    updatedAt: nowIso(),
    lastOperation: operation,
    previousBackupId,
    managedPaths: [...CODEX_MANAGED_RUNTIME_PATHS],
    preservedProjectPaths: [...CODEX_PRESERVED_PROJECT_PATHS],
  };
  writeFileSync(metadataPath(targetDir), JSON.stringify(metadata, null, 2) + "\n");
  return metadata;
}

function appendHistory(targetDir, event) {
  mkdirSync(managementRoot(targetDir), { recursive: true });
  appendFileSync(historyPath(targetDir), JSON.stringify({
    schema: "orchestra.codex-project-runtime-event.v1",
    observedAt: nowIso(),
    ...event,
  }) + "\n");
}

function readActiveState(targetDir) {
  const path = join(targetDir, ".codex", "orchestra-state", "active-state.json");
  if (!existsSync(path)) return { exists: false, state: null, parseError: false, value: null };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return { exists: true, state: String(value?.state || "").toUpperCase() || null, parseError: false, value };
  } catch {
    return { exists: true, state: null, parseError: true, value: null };
  }
}

export function checkCodexRuntimeQuiescence(targetDir) {
  const active = readActiveState(resolve(targetDir));
  if (!active.exists) return { safe: true, reason: "NO_ACTIVE_STATE", activeState: null };
  if (active.parseError) return { safe: false, reason: "ACTIVE_STATE_UNREADABLE", activeState: null };
  if (!active.state) return { safe: false, reason: "ACTIVE_STATE_UNKNOWN", activeState: active.value };
  if (QUIESCENT_STATES.has(active.state)) return { safe: true, reason: "QUIESCENT_" + active.state, activeState: active.value };
  if (ACTIVE_STATES.has(active.state)) return { safe: false, reason: "RUNTIME_ACTIVE_" + active.state, activeState: active.value };
  return { safe: false, reason: "UNRECOGNIZED_STATE_" + active.state, activeState: active.value };
}

function makeBackupId(targetDir, manifestHash) {
  const stamp = nowIso().replace(/[-:.]/g, "");
  const prefix = String(manifestHash || "legacy").slice(0, 10);
  let candidate = stamp + "-" + prefix;
  let counter = 1;
  while (existsSync(join(backupsRoot(targetDir), candidate))) {
    candidate = stamp + "-" + prefix + "-" + counter++;
  }
  return candidate;
}

export function createCodexRuntimeBackup(targetDir, { reason = "update" } = {}) {
  const target = resolve(targetDir);
  ensureTargetExists(target);
  const currentManifest = buildCodexRuntimeManifest(target);
  const backupId = makeBackupId(target, currentManifest.hash);
  const backupDir = join(backupsRoot(target), backupId);
  mkdirSync(backupDir, { recursive: true });

  for (const rel of CODEX_MANAGED_RUNTIME_PATHS) {
    const source = join(target, rel);
    if (!existsSync(source)) continue;
    const destination = join(backupDir, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true, dereference: false, preserveTimestamps: true });
  }

  const metadata = readInstalledCodexRuntimeMetadata(target);
  if (metadata) {
    mkdirSync(join(backupDir, ".codex"), { recursive: true });
    writeFileSync(join(backupDir, ".codex", "orchestra-runtime.json"), JSON.stringify(metadata, null, 2) + "\n");
  }
  writeFileSync(join(backupDir, "backup.json"), JSON.stringify({
    schema: "orchestra.codex-project-runtime-backup.v1",
    backupId,
    createdAt: nowIso(),
    reason,
    manifestHash: currentManifest.hash,
    runtimeMetadata: metadata,
    managedPaths: [...CODEX_MANAGED_RUNTIME_PATHS],
  }, null, 2) + "\n");

  return { backupId, backupDir, manifestHash: currentManifest.hash };
}

export function listCodexRuntimeBackups(targetDir) {
  const root = backupsRoot(resolve(targetDir));
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const metadata = readJson(join(root, entry.name, "backup.json"), {});
      return {
        backupId: entry.name,
        createdAt: metadata.createdAt || null,
        reason: metadata.reason || null,
        manifestHash: metadata.manifestHash || null,
      };
    })
    .sort((a, b) => b.backupId.localeCompare(a.backupId));
}

function assertQuiescentOrForced(targetDir, force) {
  const quiescence = checkCodexRuntimeQuiescence(targetDir);
  if (!quiescence.safe && !force) {
    const error = new Error("CODEX_RUNTIME_NOT_QUIESCENT: " + quiescence.reason + ". Stop the active Codex task/session or re-run with --force.");
    error.code = "CODEX_RUNTIME_NOT_QUIESCENT";
    error.quiescence = quiescence;
    throw error;
  }
  return quiescence;
}

function runtimePresent(targetDir) {
  return existsSync(join(targetDir, ".codex", "config.toml"))
    || existsSync(join(targetDir, ".codex", "astra-orchestra", "routing-policy.mjs"));
}

export function installCodexProjectRuntime({ sourceRuntimeRoot, targetDir, dryRun = false } = {}) {
  const target = resolve(targetDir);
  const source = getCodexSourceRuntimeDescriptor(sourceRuntimeRoot);
  ensureTargetExists(target);
  if (existsSync(join(target, ".codex"))) {
    const error = new Error("CODEX_INSTALL_CONFLICT: .codex already exists");
    error.code = "CODEX_INSTALL_CONFLICT";
    throw error;
  }
  if (dryRun) {
    return {
      operation: "install", dryRun: true, targetDir: target,
      sourceCommit: source.sourceCommit, orchestraVersion: source.orchestraVersion,
      manifestHash: source.manifest.hash,
    };
  }
  mkdirSync(join(target, ".codex"), { recursive: true });
  installManagedRuntime(source.sourceRuntimeRoot, target);
  const metadata = writeMetadata(target, source, { operation: "install" });
  appendHistory(target, { eventType: "INSTALL", sourceCommit: source.sourceCommit, orchestraVersion: source.orchestraVersion, manifestHash: metadata.manifestHash });
  return { operation: "install", targetDir: target, metadata };
}

export function diffCodexProjectRuntime({ sourceRuntimeRoot, targetDir } = {}) {
  const target = resolve(targetDir);
  ensureTargetExists(target);
  const source = getCodexSourceRuntimeDescriptor(sourceRuntimeRoot);
  const targetManifest = buildCodexRuntimeManifest(target);
  return {
    targetDir: target,
    sourceCommit: source.sourceCommit,
    orchestraVersion: source.orchestraVersion,
    sourceManifestHash: source.manifest.hash,
    targetManifestHash: targetManifest.hash,
    ...diffCodexRuntimeManifests(source.manifest, targetManifest),
  };
}

export function updateCodexProjectRuntime({
  sourceRuntimeRoot,
  targetDir,
  dryRun = false,
  force = false,
} = {}) {
  const target = resolve(targetDir);
  ensureTargetExists(target);
  if (!runtimePresent(target)) {
    const error = new Error("CODEX_RUNTIME_NOT_INSTALLED: use install first");
    error.code = "CODEX_RUNTIME_NOT_INSTALLED";
    throw error;
  }
  const quiescence = assertQuiescentOrForced(target, force);
  const source = getCodexSourceRuntimeDescriptor(sourceRuntimeRoot);
  const beforeMetadata = readInstalledCodexRuntimeMetadata(target);
  const beforeManifest = buildCodexRuntimeManifest(target);
  const diff = diffCodexRuntimeManifests(source.manifest, beforeManifest);
  const metadataChanged = Boolean(beforeMetadata) && (
    beforeMetadata.orchestraVersion !== source.orchestraVersion
    || beforeMetadata.sourceCommit !== source.sourceCommit
  );

  if (dryRun) {
    return {
      operation: "update", dryRun: true, targetDir: target, quiescence, diff,
      currentMetadata: beforeMetadata, sourceCommit: source.sourceCommit,
      orchestraVersion: source.orchestraVersion,
      metadataChanged,
    };
  }
  if (diff.clean && beforeMetadata?.manifestHash === source.manifest.hash) {
    if (metadataChanged) {
      const metadata = writeMetadata(target, source, {
        operation: "metadata-sync",
        previousBackupId: beforeMetadata?.previousBackupId || null,
        installedAt: beforeMetadata?.installedAt || null,
      });
      appendHistory(target, {
        eventType: "METADATA_SYNC",
        fromCommit: beforeMetadata?.sourceCommit || null,
        toCommit: source.sourceCommit,
        fromVersion: beforeMetadata?.orchestraVersion || null,
        orchestraVersion: source.orchestraVersion,
        manifestHash: metadata.manifestHash,
      });
      return {
        operation: "metadata-sync",
        changed: true,
        runtimeChanged: false,
        metadataChanged: true,
        targetDir: target,
        quiescence,
        metadata,
        diff,
      };
    }
    return {
      operation: "update",
      changed: false,
      runtimeChanged: false,
      metadataChanged: false,
      targetDir: target,
      quiescence,
      metadata: beforeMetadata,
      diff,
    };
  }

  const backup = createCodexRuntimeBackup(target, { reason: beforeMetadata ? "pre-update" : "legacy-adoption" });
  removeManagedRuntime(target);
  installManagedRuntime(source.sourceRuntimeRoot, target);
  const metadata = writeMetadata(target, source, {
    operation: beforeMetadata ? "update" : "adopt",
    previousBackupId: backup.backupId,
    installedAt: beforeMetadata?.installedAt || null,
  });
  appendHistory(target, {
    eventType: beforeMetadata ? "UPDATE" : "ADOPT",
    backupId: backup.backupId,
    fromCommit: beforeMetadata?.sourceCommit || null,
    toCommit: source.sourceCommit,
    orchestraVersion: source.orchestraVersion,
    manifestHash: metadata.manifestHash,
  });
  return { operation: beforeMetadata ? "update" : "adopt", changed: true, targetDir: target, quiescence, backup, metadata, diff };
}

function selectBackup(targetDir, backupId) {
  const backups = listCodexRuntimeBackups(targetDir);
  if (backups.length === 0) throw new Error("NO_CODEX_RUNTIME_BACKUPS");
  if (!backupId || backupId === "latest") return backups[0];
  const match = backups.find((item) => item.backupId === backupId);
  if (!match) throw new Error("CODEX_BACKUP_NOT_FOUND: " + backupId);
  return match;
}

export function rollbackCodexProjectRuntime({
  targetDir,
  backupId = "latest",
  dryRun = false,
  force = false,
} = {}) {
  const target = resolve(targetDir);
  ensureTargetExists(target);
  assertQuiescentOrForced(target, force);
  const selected = selectBackup(target, backupId);
  const selectedDir = join(backupsRoot(target), selected.backupId);
  const backupMetadata = readJson(join(selectedDir, "backup.json"), {});
  if (dryRun) return { operation: "rollback", dryRun: true, targetDir: target, selectedBackup: selected, backupMetadata };

  const safetyBackup = createCodexRuntimeBackup(target, { reason: "pre-rollback" });
  removeManagedRuntime(target);
  for (const rel of CODEX_MANAGED_RUNTIME_PATHS) {
    const source = join(selectedDir, rel);
    if (!existsSync(source)) continue;
    const destination = join(target, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true, dereference: false, preserveTimestamps: true });
  }
  ensureProjectStateDirs(target);

  const restoredMetadata = readJson(join(selectedDir, ".codex", "orchestra-runtime.json"), null);
  if (restoredMetadata) {
    writeFileSync(metadataPath(target), JSON.stringify({
      ...restoredMetadata,
      updatedAt: nowIso(),
      lastOperation: "rollback",
      previousBackupId: safetyBackup.backupId,
    }, null, 2) + "\n");
  } else {
    rmSync(metadataPath(target), { force: true });
  }
  appendHistory(target, {
    eventType: "ROLLBACK",
    restoredBackupId: selected.backupId,
    safetyBackupId: safetyBackup.backupId,
    restoredManifestHash: backupMetadata.manifestHash || null,
  });
  return { operation: "rollback", targetDir: target, restoredBackup: selected, safetyBackup, metadata: readInstalledCodexRuntimeMetadata(target) };
}

export function doctorCodexProjectRuntime({ targetDir, sourceRuntimeRoot = null } = {}) {
  const target = resolve(targetDir);
  const checks = [];
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return { healthy: false, status: "UNHEALTHY", targetDir: target, checks: [{ id: "TARGET", ok: false, detail: "Target directory does not exist" }] };
  }

  const metadata = readInstalledCodexRuntimeMetadata(target);
  checks.push({
    id: "METADATA",
    ok: Boolean(metadata && metadata.schema === CODEX_PROJECT_RUNTIME_SCHEMA),
    detail: metadata ? "schema=" + metadata.schema : "missing .codex/orchestra-runtime.json",
  });
  for (const rel of CODEX_MANAGED_RUNTIME_PATHS) {
    checks.push({ id: "MANAGED:" + rel, ok: existsSync(join(target, rel)), detail: existsSync(join(target, rel)) ? "present" : "missing" });
  }

  const manifest = buildCodexRuntimeManifest(target);
  const integrityOk = Boolean(metadata?.manifestHash) && metadata.manifestHash === manifest.hash;
  checks.push({ id: "RUNTIME_INTEGRITY", ok: integrityOk, detail: integrityOk ? "managed runtime matches installed manifest" : "managed runtime drift detected" });

  const quiescence = checkCodexRuntimeQuiescence(target);
  checks.push({ id: "RUNTIME_STATE", ok: true, detail: quiescence.reason });

  const preservedProjectPaths = CODEX_PRESERVED_PROJECT_PATHS.map((path) => ({ path, exists: existsSync(join(target, path)) }));
  let sourceComparison = null;
  if (sourceRuntimeRoot) {
    const source = getCodexSourceRuntimeDescriptor(sourceRuntimeRoot);
    const diff = diffCodexRuntimeManifests(source.manifest, manifest);
    const metadataVersionMatches = metadata?.orchestraVersion === source.orchestraVersion;
    const metadataCommitMatches = metadata?.sourceCommit === source.sourceCommit;
    const upToDate = diff.clean && metadataVersionMatches && metadataCommitMatches;
    sourceComparison = {
      sourceCommit: source.sourceCommit,
      orchestraVersion: source.orchestraVersion,
      upToDate,
      metadataVersionMatches,
      metadataCommitMatches,
      diff,
    };
    checks.push({
      id: "SOURCE_VERSION",
      ok: upToDate,
      detail: upToDate
        ? "installed runtime and metadata match current source"
        : "installed runtime or metadata differs from current source",
    });
  }

  const healthy = checks.every((check) => check.ok);
  return {
    healthy, status: healthy ? "HEALTHY" : "UNHEALTHY", targetDir: target,
    metadata, manifestHash: manifest.hash, quiescence, preservedProjectPaths,
    backups: listCodexRuntimeBackups(target), sourceComparison, checks,
  };
}

export function getCodexProjectRuntimeVersion(targetDir) {
  const target = resolve(targetDir);
  ensureTargetExists(target);
  const metadata = readInstalledCodexRuntimeMetadata(target);
  const manifest = buildCodexRuntimeManifest(target);
  return {
    installed: runtimePresent(target),
    managed: Boolean(metadata),
    runtime: "CODEX",
    targetDir: target,
    orchestraVersion: metadata?.orchestraVersion || null,
    sourceCommit: metadata?.sourceCommit || null,
    sourceBranch: metadata?.sourceBranch || null,
    installedAt: metadata?.installedAt || null,
    updatedAt: metadata?.updatedAt || null,
    manifestHash: metadata?.manifestHash || manifest.hash,
    currentManifestHash: manifest.hash,
    drifted: Boolean(metadata?.manifestHash) && metadata.manifestHash !== manifest.hash,
    lastOperation: metadata?.lastOperation || null,
    previousBackupId: metadata?.previousBackupId || null,
  };
}
