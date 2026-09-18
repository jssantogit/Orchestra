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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const PROJECT_RUNTIME_SCHEMA = "orchestra.project-runtime.v1";
export const PROJECT_RUNTIME_MANAGER_VERSION = 1;

export const MANAGED_RUNTIME_PATHS = Object.freeze([
  ".agents/agents",
  ".agents/hooks",
  ".agents/skills",
  ".agents/dream",
  ".agents/hooks.json",
  "GEMINI.md",
]);

export const PRESERVED_PROJECT_PATHS = Object.freeze([
  ".agents/rules",
  ".agents/state",
  ".agents/telemetry",
  ".agents/dream-data",
  ".agents/artifacts",
  ".agents/runtime-management",
]);

const QUIESCENT_STATES = new Set(["DONE", "BLOCKED", "HUMAN_GATE"]);
const ACTIVE_STATES = new Set([
  "CLASSIFIED",
  "DIRECT_ACTION",
  "PLANNED",
  "DELEGATED",
  "EXECUTING",
  "EVIDENCE_READY",
  "CI_WAIT",
  "ACCEPTANCE",
  "INTEGRATING",
  "CRITICAL_REVIEW",
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
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || "").trim() || null;
}

function ensureTargetExists(targetDir) {
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    throw new Error("TARGET_NOT_FOUND: " + targetDir);
  }
}

function runtimeMetadataPath(targetDir) {
  return join(targetDir, ".agents", "orchestra-runtime.json");
}

function managementRoot(targetDir) {
  return join(targetDir, ".agents", "runtime-management");
}

function backupsRoot(targetDir) {
  return join(managementRoot(targetDir), "backups");
}

function historyPath(targetDir) {
  return join(managementRoot(targetDir), "history.jsonl");
}

function ensureProjectStateDirs(targetDir) {
  const dirs = [
    ".agents/state",
    ".agents/state/dream",
    ".agents/telemetry",
    ".agents/artifacts",
    ".agents/artifacts/outputs",
    ".agents/runtime-management/backups",
  ];
  for (const rel of dirs) mkdirSync(join(targetDir, rel), { recursive: true });

  const keepFiles = [
    ".agents/state/.gitkeep",
    ".agents/state/dream/.gitkeep",
    ".agents/telemetry/.gitkeep",
    ".agents/artifacts/.gitkeep",
    ".agents/artifacts/outputs/.gitkeep",
  ];
  for (const rel of keepFiles) {
    const path = join(targetDir, rel);
    if (!existsSync(path)) writeFileSync(path, "");
  }
}

function sanitizeCopiedRuntime(targetDir) {
  // Runtime code under .agents/dream must never contain historical data.
  rmSync(join(targetDir, ".agents", "dream", "dream-data"), {
    recursive: true,
    force: true,
  });
}

function copyPath(sourceBase, targetBase, relPath) {
  const source = join(sourceBase, relPath);
  const target = join(targetBase, relPath);
  if (!existsSync(source)) {
    throw new Error("SOURCE_RUNTIME_PATH_MISSING: " + relPath);
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    preserveTimestamps: true,
  });
}

function removeManagedRuntime(targetDir) {
  for (const rel of MANAGED_RUNTIME_PATHS) {
    rmSync(join(targetDir, rel), { recursive: true, force: true });
  }
}

function installManagedRuntime(sourceRuntimeRoot, targetDir) {
  for (const rel of MANAGED_RUNTIME_PATHS) {
    copyPath(sourceRuntimeRoot, targetDir, rel);
  }
  sanitizeCopiedRuntime(targetDir);
  ensureProjectStateDirs(targetDir);
}

function collectPathEntries(baseDir, relPath, entries) {
  const full = join(baseDir, relPath);
  if (!existsSync(full)) {
    entries.push({
      path: portable(relPath),
      type: "missing",
      digest: null,
    });
    return;
  }

  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(full);
    entries.push({
      path: portable(relPath),
      type: "symlink",
      digest: sha256("symlink:" + target),
      target,
    });
    return;
  }

  if (stat.isFile()) {
    const body = readFileSync(full);
    entries.push({
      path: portable(relPath),
      type: "file",
      digest: sha256(body),
      size: stat.size,
    });
    return;
  }

  if (!stat.isDirectory()) {
    entries.push({
      path: portable(relPath),
      type: "other",
      digest: sha256(String(stat.mode)),
    });
    return;
  }

  entries.push({
    path: portable(relPath),
    type: "dir",
    digest: null,
  });

  const children = readdirSync(full).sort();
  for (const child of children) {
    collectPathEntries(baseDir, join(relPath, child), entries);
  }
}

export function buildRuntimeManifest(baseDir) {
  const entries = [];
  for (const rel of MANAGED_RUNTIME_PATHS) {
    collectPathEntries(baseDir, rel, entries);
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  const canonical = entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
    digest: entry.digest,
    target: entry.target || null,
  }));

  return {
    entries,
    hash: sha256(JSON.stringify(canonical)),
  };
}

function manifestMap(manifest) {
  return new Map(manifest.entries.map((entry) => [entry.path, entry]));
}

export function diffRuntimeManifests(sourceManifest, targetManifest) {
  const source = manifestMap(sourceManifest);
  const target = manifestMap(targetManifest);
  const paths = [...new Set([...source.keys(), ...target.keys()])].sort();

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const path of paths) {
    const a = source.get(path);
    const b = target.get(path);

    if (!b || b.type === "missing") {
      if (a && a.type !== "missing") added.push(path);
      continue;
    }
    if (!a || a.type === "missing") {
      if (b.type !== "missing") removed.push(path);
      continue;
    }

    if (
      a.type !== b.type
      || a.digest !== b.digest
      || (a.target || null) !== (b.target || null)
    ) {
      changed.push(path);
    } else {
      unchanged.push(path);
    }
  }

  return {
    clean: added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
    unchanged,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
    },
  };
}

export function getSourceRuntimeDescriptor(sourceRuntimeRoot) {
  const resolvedSource = resolve(sourceRuntimeRoot);
  const orchestraRoot = resolve(resolvedSource, "..", "..");
  const packageJson = readJson(join(orchestraRoot, "package.json"), {});
  const manifest = buildRuntimeManifest(resolvedSource);

  return {
    sourceRuntimeRoot: resolvedSource,
    orchestraRoot,
    orchestraVersion: packageJson.version || "unknown",
    sourceCommit: git(orchestraRoot, ["rev-parse", "HEAD"]),
    sourceBranch: git(orchestraRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    manifest,
  };
}

export function readInstalledRuntimeMetadata(targetDir) {
  return readJson(runtimeMetadataPath(resolve(targetDir)), null);
}

function writeRuntimeMetadata(targetDir, source, {
  operation,
  previousBackupId = null,
  installedAt = null,
} = {}) {
  const targetManifest = buildRuntimeManifest(targetDir);
  const existing = readInstalledRuntimeMetadata(targetDir);
  const timestamp = nowIso();

  const metadata = {
    schema: PROJECT_RUNTIME_SCHEMA,
    managerVersion: PROJECT_RUNTIME_MANAGER_VERSION,
    runtime: "antigravity",
    orchestraVersion: source.orchestraVersion,
    sourceCommit: source.sourceCommit,
    sourceBranch: source.sourceBranch,
    manifestHash: targetManifest.hash,
    managedPaths: [...MANAGED_RUNTIME_PATHS],
    preservedProjectPaths: [...PRESERVED_PROJECT_PATHS],
    installedAt: installedAt || existing?.installedAt || timestamp,
    updatedAt: timestamp,
    lastOperation: operation,
    previousBackupId,
  };

  mkdirSync(dirname(runtimeMetadataPath(targetDir)), { recursive: true });
  writeFileSync(runtimeMetadataPath(targetDir), JSON.stringify(metadata, null, 2) + "\n");
  return metadata;
}

function appendHistory(targetDir, event) {
  mkdirSync(managementRoot(targetDir), { recursive: true });
  appendFileSync(historyPath(targetDir), JSON.stringify({
    schema: "orchestra.project-runtime-event.v1",
    observedAt: nowIso(),
    ...event,
  }) + "\n");
}

function readActiveState(targetDir) {
  const path = join(targetDir, ".agents", "state", "active-state.json");
  if (!existsSync(path)) return { exists: false, state: null, parseError: false, value: null };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return {
      exists: true,
      state: String(value?.state || "").toUpperCase() || null,
      parseError: false,
      value,
    };
  } catch {
    return { exists: true, state: null, parseError: true, value: null };
  }
}

export function checkRuntimeQuiescence(targetDir) {
  const active = readActiveState(targetDir);
  if (!active.exists) {
    return { safe: true, reason: "NO_ACTIVE_STATE", activeState: null };
  }
  if (active.parseError) {
    return { safe: false, reason: "ACTIVE_STATE_UNREADABLE", activeState: null };
  }
  if (!active.state) {
    return { safe: false, reason: "ACTIVE_STATE_UNKNOWN", activeState: active.value };
  }
  if (QUIESCENT_STATES.has(active.state)) {
    return { safe: true, reason: "QUIESCENT_" + active.state, activeState: active.value };
  }
  if (ACTIVE_STATES.has(active.state)) {
    return { safe: false, reason: "RUNTIME_ACTIVE_" + active.state, activeState: active.value };
  }
  return { safe: false, reason: "UNRECOGNIZED_STATE_" + active.state, activeState: active.value };
}

function makeBackupId(targetDir, manifestHash) {
  const stamp = nowIso().replace(/[-:.]/g, "").replace("Z", "Z");
  const prefix = String(manifestHash || "legacy").slice(0, 10);
  let candidate = stamp + "-" + prefix;
  let counter = 1;
  while (existsSync(join(backupsRoot(targetDir), candidate))) {
    candidate = stamp + "-" + prefix + "-" + counter;
    counter++;
  }
  return candidate;
}

export function createRuntimeBackup(targetDir, {
  reason = "update",
} = {}) {
  ensureTargetExists(targetDir);
  const currentManifest = buildRuntimeManifest(targetDir);
  const backupId = makeBackupId(targetDir, currentManifest.hash);
  const backupDir = join(backupsRoot(targetDir), backupId);

  mkdirSync(backupDir, { recursive: true });
  for (const rel of MANAGED_RUNTIME_PATHS) {
    const source = join(targetDir, rel);
    if (!existsSync(source)) continue;
    const target = join(backupDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, {
      recursive: true,
      force: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }

  const installedMetadata = readInstalledRuntimeMetadata(targetDir);
  if (installedMetadata) {
    mkdirSync(join(backupDir, ".agents"), { recursive: true });
    writeFileSync(
      join(backupDir, ".agents", "orchestra-runtime.json"),
      JSON.stringify(installedMetadata, null, 2) + "\n"
    );
  }

  writeFileSync(join(backupDir, "backup.json"), JSON.stringify({
    schema: "orchestra.project-runtime-backup.v1",
    backupId,
    createdAt: nowIso(),
    reason,
    manifestHash: currentManifest.hash,
    runtimeMetadata: installedMetadata,
    managedPaths: [...MANAGED_RUNTIME_PATHS],
  }, null, 2) + "\n");

  return {
    backupId,
    backupDir,
    manifestHash: currentManifest.hash,
  };
}

export function listRuntimeBackups(targetDir) {
  const root = backupsRoot(resolve(targetDir));
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(root, entry.name);
      const metadata = readJson(join(dir, "backup.json"), {});
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
  const quiescence = checkRuntimeQuiescence(targetDir);
  if (!quiescence.safe && !force) {
    const error = new Error(
      "RUNTIME_NOT_QUIESCENT: " + quiescence.reason
      + ". Stop the active AGY task/session or re-run with --force."
    );
    error.code = "RUNTIME_NOT_QUIESCENT";
    error.quiescence = quiescence;
    throw error;
  }
  return quiescence;
}

function runtimePresent(targetDir) {
  return existsSync(join(targetDir, ".agents"))
    && (
      existsSync(join(targetDir, ".agents", "hooks.json"))
      || existsSync(join(targetDir, ".agents", "skills", "orchestra", "routing-policy.mjs"))
    );
}

export function installProjectRuntime({
  sourceRuntimeRoot,
  targetDir,
  dryRun = false,
} = {}) {
  const target = resolve(targetDir);
  const source = getSourceRuntimeDescriptor(sourceRuntimeRoot);
  ensureTargetExists(target);

  const targetAgents = join(target, ".agents");
  const targetGemini = join(target, "GEMINI.md");
  if (existsSync(targetAgents) || existsSync(targetGemini)) {
    const error = new Error("INSTALL_CONFLICT: .agents or GEMINI.md already exists");
    error.code = "INSTALL_CONFLICT";
    throw error;
  }

  if (dryRun) {
    return {
      operation: "install",
      dryRun: true,
      targetDir: target,
      sourceCommit: source.sourceCommit,
      orchestraVersion: source.orchestraVersion,
      manifestHash: source.manifest.hash,
    };
  }

  mkdirSync(targetAgents, { recursive: true });
  installManagedRuntime(source.sourceRuntimeRoot, target);

  const metadata = writeRuntimeMetadata(target, source, {
    operation: "install",
  });

  appendHistory(target, {
    eventType: "INSTALL",
    sourceCommit: source.sourceCommit,
    orchestraVersion: source.orchestraVersion,
    manifestHash: metadata.manifestHash,
  });

  return {
    operation: "install",
    targetDir: target,
    metadata,
  };
}

export function diffProjectRuntime({
  sourceRuntimeRoot,
  targetDir,
} = {}) {
  const target = resolve(targetDir);
  ensureTargetExists(target);
  const source = getSourceRuntimeDescriptor(sourceRuntimeRoot);
  const targetManifest = buildRuntimeManifest(target);
  const diff = diffRuntimeManifests(source.manifest, targetManifest);

  return {
    targetDir: target,
    sourceCommit: source.sourceCommit,
    orchestraVersion: source.orchestraVersion,
    sourceManifestHash: source.manifest.hash,
    targetManifestHash: targetManifest.hash,
    ...diff,
  };
}

export function updateProjectRuntime({
  sourceRuntimeRoot,
  targetDir,
  dryRun = false,
  force = false,
} = {}) {
  const target = resolve(targetDir);
  ensureTargetExists(target);
  if (!runtimePresent(target)) {
    const error = new Error("RUNTIME_NOT_INSTALLED: use install first");
    error.code = "RUNTIME_NOT_INSTALLED";
    throw error;
  }

  const quiescence = assertQuiescentOrForced(target, force);
  const source = getSourceRuntimeDescriptor(sourceRuntimeRoot);
  const beforeMetadata = readInstalledRuntimeMetadata(target);
  const beforeManifest = buildRuntimeManifest(target);
  const diff = diffRuntimeManifests(source.manifest, beforeManifest);

  if (dryRun) {
    return {
      operation: "update",
      dryRun: true,
      targetDir: target,
      quiescence,
      diff,
      currentMetadata: beforeMetadata,
      sourceCommit: source.sourceCommit,
      orchestraVersion: source.orchestraVersion,
    };
  }

  if (diff.clean && beforeMetadata?.manifestHash === source.manifest.hash) {
    return {
      operation: "update",
      changed: false,
      targetDir: target,
      quiescence,
      metadata: beforeMetadata,
      diff,
    };
  }

  const backup = createRuntimeBackup(target, { reason: "pre-update" });
  removeManagedRuntime(target);
  installManagedRuntime(source.sourceRuntimeRoot, target);

  const metadata = writeRuntimeMetadata(target, source, {
    operation: "update",
    previousBackupId: backup.backupId,
    installedAt: beforeMetadata?.installedAt || null,
  });

  appendHistory(target, {
    eventType: "UPDATE",
    backupId: backup.backupId,
    fromCommit: beforeMetadata?.sourceCommit || null,
    toCommit: source.sourceCommit,
    orchestraVersion: source.orchestraVersion,
    manifestHash: metadata.manifestHash,
  });

  return {
    operation: "update",
    changed: true,
    targetDir: target,
    quiescence,
    backup,
    metadata,
    diff,
  };
}

function selectBackup(targetDir, backupId) {
  const backups = listRuntimeBackups(targetDir);
  if (backups.length === 0) {
    const error = new Error("NO_RUNTIME_BACKUPS");
    error.code = "NO_RUNTIME_BACKUPS";
    throw error;
  }
  if (!backupId || backupId === "latest") return backups[0];
  const match = backups.find((item) => item.backupId === backupId);
  if (!match) {
    const error = new Error("BACKUP_NOT_FOUND: " + backupId);
    error.code = "BACKUP_NOT_FOUND";
    throw error;
  }
  return match;
}

export function rollbackProjectRuntime({
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

  if (dryRun) {
    return {
      operation: "rollback",
      dryRun: true,
      targetDir: target,
      selectedBackup: selected,
      backupMetadata,
    };
  }

  const safetyBackup = createRuntimeBackup(target, { reason: "pre-rollback" });
  removeManagedRuntime(target);

  for (const rel of MANAGED_RUNTIME_PATHS) {
    const source = join(selectedDir, rel);
    if (!existsSync(source)) continue;
    const destination = join(target, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, {
      recursive: true,
      force: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }

  sanitizeCopiedRuntime(target);
  ensureProjectStateDirs(target);

  const restoredMetadata = readJson(
    join(selectedDir, ".agents", "orchestra-runtime.json"),
    null
  );
  if (restoredMetadata) {
    writeFileSync(
      runtimeMetadataPath(target),
      JSON.stringify({
        ...restoredMetadata,
        updatedAt: nowIso(),
        lastOperation: "rollback",
        previousBackupId: safetyBackup.backupId,
      }, null, 2) + "\n"
    );
  } else {
    rmSync(runtimeMetadataPath(target), { force: true });
  }

  appendHistory(target, {
    eventType: "ROLLBACK",
    restoredBackupId: selected.backupId,
    safetyBackupId: safetyBackup.backupId,
    restoredManifestHash: backupMetadata.manifestHash || null,
  });

  return {
    operation: "rollback",
    targetDir: target,
    restoredBackup: selected,
    safetyBackup,
    metadata: readInstalledRuntimeMetadata(target),
  };
}

export function doctorProjectRuntime({
  targetDir,
  sourceRuntimeRoot = null,
} = {}) {
  const target = resolve(targetDir);
  const checks = [];

  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return {
      healthy: false,
      status: "UNHEALTHY",
      targetDir: target,
      checks: [{ id: "TARGET", ok: false, detail: "Target directory does not exist" }],
    };
  }

  const metadata = readInstalledRuntimeMetadata(target);
  checks.push({
    id: "METADATA",
    ok: Boolean(metadata && metadata.schema === PROJECT_RUNTIME_SCHEMA),
    detail: metadata
      ? "schema=" + String(metadata.schema)
      : "missing .agents/orchestra-runtime.json",
  });

  for (const rel of MANAGED_RUNTIME_PATHS) {
    checks.push({
      id: "MANAGED:" + rel,
      ok: existsSync(join(target, rel)),
      detail: existsSync(join(target, rel)) ? "present" : "missing",
    });
  }

  const manifest = buildRuntimeManifest(target);
  const integrityOk = Boolean(metadata?.manifestHash)
    && metadata.manifestHash === manifest.hash;
  checks.push({
    id: "RUNTIME_INTEGRITY",
    ok: integrityOk,
    detail: integrityOk
      ? "managed runtime matches installed manifest"
      : "managed runtime drift detected",
  });

  const quiescence = checkRuntimeQuiescence(target);
  checks.push({
    id: "RUNTIME_STATE",
    ok: true,
    detail: quiescence.reason,
  });

  const projectPaths = PRESERVED_PROJECT_PATHS.map((rel) => ({
    path: rel,
    exists: existsSync(join(target, rel)),
  }));

  let sourceComparison = null;
  if (sourceRuntimeRoot) {
    const source = getSourceRuntimeDescriptor(sourceRuntimeRoot);
    const diff = diffRuntimeManifests(source.manifest, manifest);
    sourceComparison = {
      sourceCommit: source.sourceCommit,
      orchestraVersion: source.orchestraVersion,
      upToDate: diff.clean,
      diff,
    };
    checks.push({
      id: "SOURCE_VERSION",
      ok: diff.clean,
      detail: diff.clean
        ? "installed runtime matches current source"
        : "installed runtime differs from current source",
    });
  }

  const healthy = checks.every((check) => check.ok);

  return {
    healthy,
    status: healthy ? "HEALTHY" : "UNHEALTHY",
    targetDir: target,
    metadata,
    manifestHash: manifest.hash,
    quiescence,
    preservedProjectPaths: projectPaths,
    backups: listRuntimeBackups(target),
    sourceComparison,
    checks,
  };
}

export function getProjectRuntimeVersion(targetDir) {
  const target = resolve(targetDir);
  ensureTargetExists(target);
  const metadata = readInstalledRuntimeMetadata(target);
  const manifest = buildRuntimeManifest(target);

  return {
    installed: runtimePresent(target),
    managed: Boolean(metadata),
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
