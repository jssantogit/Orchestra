import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ARTIFACT_ROOT = ".orchestra/state/delegation/composite-artifacts";
const ARTIFACT_SCHEMA = "orchestra.parallel-composite-artifact.v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const STATES = new Set(["READY_FOR_REVIEW", "PROMOTED", "DISCARDED"]);
const TOP_LEVEL_KEYS = new Set([
  "schema",
  "artifactId",
  "groupId",
  "taskId",
  "generation",
  "source",
  "sourceRevision",
  "sourceFingerprint",
  "canonicalGitFingerprint",
  "delegatedPath",
  "syntheticBaselineSha",
  "memberArtifactIds",
  "changedPaths",
  "patchSha256",
  "mutationDigest",
  "state",
  "createdAt",
  "cleanup",
]);
const SOURCE_KEYS = new Set(["provider", "actorIdHash"]);
const CLEANUP_KEYS = new Set(["cleaned", "reason", "recoverablePath"]);

function invalid(code = "COMPOSITE_ARTIFACT_INVALID") {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function assertCompositeArtifactId(value) {
  if (typeof value !== "string"
      || value === "."
      || value === ".."
      || !SAFE_ID.test(value)) {
    invalid("COMPOSITE_ARTIFACT_ID_INVALID");
  }
  return value;
}

function safeId(value) {
  return typeof value === "string"
    && value !== "."
    && value !== ".."
    && SAFE_ID.test(value);
}

function exactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function boundedStrings(values, { maxItems = 512, maxLength = 512, exactItems = null } = {}) {
  return Array.isArray(values)
    && (exactItems === null || values.length === exactItems)
    && values.length <= maxItems
    && values.every((value) => boundedString(value, maxLength))
    && new Set(values).size === values.length;
}

function validTimestamp(value) {
  return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

function validCleanup(cleanup) {
  if (cleanup === undefined) return true;
  if (!exactKeys(cleanup, CLEANUP_KEYS) || typeof cleanup.cleaned !== "boolean") return false;
  if (cleanup.cleaned) {
    return cleanup.reason === null && cleanup.recoverablePath === null;
  }
  return cleanup.reason === "WORKSPACE_CLEANUP_FAILED"
    && boundedString(cleanup.recoverablePath, 4096);
}

function validateManifest(manifest) {
  if (!exactKeys(manifest, TOP_LEVEL_KEYS)) return false;
  if (manifest.schema !== ARTIFACT_SCHEMA) return false;
  if (!safeId(manifest.artifactId) || !safeId(manifest.groupId)) return false;
  if (!boundedString(manifest.taskId, 300)) return false;
  if (!Number.isInteger(manifest.generation) || manifest.generation < 0) return false;
  if (!exactKeys(manifest.source, SOURCE_KEYS)
      || !boundedString(manifest.source.provider, 120)
      || !boundedString(manifest.source.actorIdHash, 300)) return false;
  if (!boundedString(manifest.sourceRevision, 300)
      || !boundedString(manifest.sourceFingerprint, 300)
      || !boundedString(manifest.canonicalGitFingerprint, 300)
      || !boundedString(manifest.delegatedPath, 4096)
      || !boundedString(manifest.syntheticBaselineSha, 300)) return false;
  if (!boundedStrings(manifest.memberArtifactIds, { exactItems: 2, maxLength: 160 })
      || !manifest.memberArtifactIds.every(safeId)) return false;
  if (!boundedStrings(manifest.changedPaths, { maxItems: 1024 })) return false;
  if (!boundedString(manifest.patchSha256, 300)
      || !boundedString(manifest.mutationDigest, 300)
      || !STATES.has(manifest.state)
      || !validTimestamp(manifest.createdAt)
      || !validCleanup(manifest.cleanup)) return false;
  if (manifest.state === "READY_FOR_REVIEW" && manifest.cleanup !== undefined) return false;
  return true;
}

function paths(repoRoot, artifactId = null) {
  const root = resolve(repoRoot);
  const artifacts = join(root, ARTIFACT_ROOT);
  if (artifactId === null) return { root, artifacts };
  assertCompositeArtifactId(artifactId);
  const dir = join(artifacts, artifactId);
  return {
    root,
    artifacts,
    dir,
    manifest: join(dir, "manifest.json"),
    patch: join(dir, "candidate.patch"),
  };
}

function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) invalid();
  const candidate = { schema: ARTIFACT_SCHEMA, ...manifest };
  if (!validateManifest(candidate)) invalid();
  return candidate;
}

function replaceManifest(repoRoot, artifactId, manifest) {
  const p = paths(repoRoot, artifactId);
  const normalized = normalizeManifest(manifest);
  const temp = `${p.manifest}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, p.manifest);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return normalized;
}

export function writeCompositeArtifact(repoRoot, { manifest, patch } = {}) {
  const normalized = normalizeManifest(manifest);
  if (!Buffer.isBuffer(patch)) invalid();
  const p = paths(repoRoot, normalized.artifactId);
  mkdirSync(p.artifacts, { recursive: true });
  if (existsSync(p.dir)) invalid("COMPOSITE_ARTIFACT_ALREADY_EXISTS");

  const tempDir = join(
    p.artifacts,
    `.${normalized.artifactId}.${process.pid}.${Date.now()}.tmp`,
  );
  mkdirSync(tempDir, { recursive: false, mode: 0o700 });
  try {
    writeFileSync(join(tempDir, "manifest.json"), `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    writeFileSync(join(tempDir, "candidate.patch"), patch, { mode: 0o600 });
    renameSync(tempDir, p.dir);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return { manifest: normalized, patch: Buffer.from(patch), path: p.dir };
}

export function readCompositeArtifact(repoRoot, artifactId) {
  const p = paths(repoRoot, artifactId);
  if (!existsSync(p.dir)) {
    return {
      exists: false,
      valid: true,
      manifest: null,
      patch: null,
      reason: null,
      path: p.dir,
    };
  }
  if (!existsSync(p.manifest) || !existsSync(p.patch)) {
    return {
      exists: true,
      valid: false,
      manifest: null,
      patch: null,
      reason: "COMPOSITE_ARTIFACT_INCOMPLETE",
      path: p.dir,
    };
  }

  let manifest;
  let patch;
  try {
    manifest = JSON.parse(readFileSync(p.manifest, "utf8"));
    patch = readFileSync(p.patch);
  } catch {
    return {
      exists: true,
      valid: false,
      manifest: null,
      patch: null,
      reason: "COMPOSITE_ARTIFACT_PARSE_INVALID",
      path: p.dir,
    };
  }
  if (!validateManifest(manifest)) {
    return {
      exists: true,
      valid: false,
      manifest,
      patch,
      reason: "COMPOSITE_ARTIFACT_INVALID",
      path: p.dir,
    };
  }
  return { exists: true, valid: true, manifest, patch, reason: null, path: p.dir };
}

export function listCompositeArtifacts(repoRoot) {
  const p = paths(repoRoot);
  if (!existsSync(p.artifacts)) return [];
  const artifacts = [];
  for (const name of readdirSync(p.artifacts).sort()) {
    if (name.startsWith(".")) continue;
    const result = readCompositeArtifact(repoRoot, name);
    if (!result.exists || !result.valid) invalid();
    artifacts.push(result.manifest);
  }
  return artifacts.sort((a, b) => a.artifactId.localeCompare(b.artifactId));
}

export function transitionCompositeArtifactState(repoRoot, artifactId, {
  expectedState,
  nextState,
  cleanup,
} = {}) {
  assertCompositeArtifactId(artifactId);
  if (!STATES.has(expectedState) || !STATES.has(nextState) || expectedState === nextState) {
    invalid("COMPOSITE_ARTIFACT_STATE_INVALID");
  }
  const allowed = expectedState === "READY_FOR_REVIEW"
    && (nextState === "PROMOTED" || nextState === "DISCARDED");
  if (!allowed) invalid("COMPOSITE_ARTIFACT_STATE_INVALID");

  const current = readCompositeArtifact(repoRoot, artifactId);
  if (!current.exists) {
    return { transitioned: false, reason: "COMPOSITE_ARTIFACT_NOT_FOUND", manifest: null };
  }
  if (!current.valid) {
    return { transitioned: false, reason: current.reason ?? "COMPOSITE_ARTIFACT_INVALID", manifest: current.manifest };
  }
  if (current.manifest.state !== expectedState) {
    return { transitioned: false, reason: "COMPOSITE_ARTIFACT_STATE_MISMATCH", manifest: current.manifest };
  }
  if (cleanup === undefined) invalid("COMPOSITE_ARTIFACT_STATE_INVALID");

  const manifest = replaceManifest(repoRoot, artifactId, {
    ...current.manifest,
    state: nextState,
    cleanup,
  });
  return { transitioned: true, reason: null, manifest };
}

export function recordCompositeArtifactCleanup(repoRoot, artifactId, cleanup) {
  assertCompositeArtifactId(artifactId);
  const current = readCompositeArtifact(repoRoot, artifactId);
  if (!current.exists) return { updated: false, reason: "COMPOSITE_ARTIFACT_NOT_FOUND", manifest: null };
  if (!current.valid) {
    return { updated: false, reason: current.reason ?? "COMPOSITE_ARTIFACT_INVALID", manifest: current.manifest };
  }
  if (current.manifest.state === "READY_FOR_REVIEW") {
    return { updated: false, reason: "COMPOSITE_ARTIFACT_STATE_MISMATCH", manifest: current.manifest };
  }
  const manifest = replaceManifest(repoRoot, artifactId, { ...current.manifest, cleanup });
  return { updated: true, reason: null, manifest };
}
