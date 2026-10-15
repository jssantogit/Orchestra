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

const ARTIFACT_ROOT = ".orchestra/state/delegation/artifacts";
const ARTIFACT_SCHEMA = "orchestra.delegation-artifact.v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const STATES = new Set(["READY_FOR_REVIEW", "PROMOTED", "DISCARDED"]);
const TOP_LEVEL_KEYS = new Set([
  "schema",
  "artifactId",
  "delegationId",
  "taskId",
  "generation",
  "source",
  "target",
  "sourceRevision",
  "sourceFingerprint",
  "canonicalGitFingerprint",
  "delegatedPath",
  "syntheticBaselineSha",
  "mutationScope",
  "changedPaths",
  "patchSha256",
  "mutationDigest",
  "state",
  "createdAt",
]);
const SOURCE_KEYS = new Set(["provider", "actorIdHash"]);
const TARGET_KEYS = new Set(["provider", "logicalRole"]);
const SCOPE_KEYS = new Set(["allowedPaths", "forbiddenPaths"]);

function invalid(code = "DELEGATION_ARTIFACT_INVALID") {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function assertArtifactId(artifactId) {
  if (typeof artifactId !== "string"
      || artifactId === "."
      || artifactId === ".."
      || !SAFE_ID.test(artifactId)) {
    invalid("ARTIFACT_ID_INVALID");
  }
  return artifactId;
}

function exactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function boundedStrings(values, { maxItems = 512, maxLength = 512, requireNonEmpty = false } = {}) {
  return Array.isArray(values)
    && (!requireNonEmpty || values.length > 0)
    && values.length <= maxItems
    && values.every((value) => boundedString(value, maxLength))
    && new Set(values).size === values.length;
}

function validTimestamp(value) {
  return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

function validateManifest(manifest) {
  if (!exactKeys(manifest, TOP_LEVEL_KEYS)) return false;
  if (manifest.schema !== ARTIFACT_SCHEMA) return false;
  try {
    assertArtifactId(manifest.artifactId);
    assertArtifactId(manifest.delegationId);
  } catch {
    return false;
  }
  if (!boundedString(manifest.taskId, 300)) return false;
  if (!Number.isInteger(manifest.generation) || manifest.generation < 0) return false;
  if (!exactKeys(manifest.source, SOURCE_KEYS)
      || !boundedString(manifest.source.provider, 120)
      || !boundedString(manifest.source.actorIdHash, 300)) return false;
  if (!exactKeys(manifest.target, TARGET_KEYS)
      || !boundedString(manifest.target.provider, 120)
      || !boundedString(manifest.target.logicalRole, 120)) return false;
  if (!boundedString(manifest.sourceRevision, 300)
      || !boundedString(manifest.sourceFingerprint, 300)
      || !boundedString(manifest.canonicalGitFingerprint, 300)
      || !boundedString(manifest.delegatedPath, 4096)
      || !boundedString(manifest.syntheticBaselineSha, 300)) return false;
  if (!exactKeys(manifest.mutationScope, SCOPE_KEYS)
      || !boundedStrings(manifest.mutationScope.allowedPaths, { maxItems: 256, requireNonEmpty: true })
      || !boundedStrings(manifest.mutationScope.forbiddenPaths, { maxItems: 256 })) return false;
  if (!boundedStrings(manifest.changedPaths, { maxItems: 512 })) return false;
  if (!boundedString(manifest.patchSha256, 300)
      || !boundedString(manifest.mutationDigest, 300)
      || !STATES.has(manifest.state)
      || !validTimestamp(manifest.createdAt)) return false;
  return true;
}

function paths(repoRoot, artifactId = null) {
  const root = resolve(repoRoot);
  const artifacts = join(root, ARTIFACT_ROOT);
  if (artifactId === null) return { root, artifacts };
  assertArtifactId(artifactId);
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

export function writeDelegationArtifact(repoRoot, { manifest, patch } = {}) {
  const normalized = normalizeManifest(manifest);
  if (!Buffer.isBuffer(patch)) invalid();
  const p = paths(repoRoot, normalized.artifactId);
  mkdirSync(p.artifacts, { recursive: true });
  if (existsSync(p.dir)) invalid("DELEGATION_ARTIFACT_ALREADY_EXISTS");

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

export function transitionDelegationArtifactState(repoRoot, artifactId, {
  expectedState,
  nextState,
} = {}) {
  assertArtifactId(artifactId);
  if (!STATES.has(expectedState) || !STATES.has(nextState) || expectedState === nextState) {
    invalid("DELEGATION_ARTIFACT_STATE_INVALID");
  }

  const current = readDelegationArtifact(repoRoot, artifactId);
  if (!current.exists) {
    return { transitioned: false, reason: "DELEGATION_ARTIFACT_NOT_FOUND", manifest: null };
  }
  if (!current.valid) {
    return { transitioned: false, reason: current.reason ?? "DELEGATION_ARTIFACT_INVALID", manifest: current.manifest };
  }
  if (current.manifest.state !== expectedState) {
    return { transitioned: false, reason: "ARTIFACT_STATE_MISMATCH", manifest: current.manifest };
  }

  const p = paths(repoRoot, artifactId);
  const manifest = normalizeManifest({ ...current.manifest, state: nextState });
  const temp = `${p.manifest}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, p.manifest);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { transitioned: true, reason: null, manifest };
}

export function readDelegationArtifact(repoRoot, artifactId) {
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
      reason: "DELEGATION_ARTIFACT_INCOMPLETE",
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
      reason: "DELEGATION_ARTIFACT_PARSE_INVALID",
      path: p.dir,
    };
  }
  if (!validateManifest(manifest)) {
    return {
      exists: true,
      valid: false,
      manifest,
      patch,
      reason: "DELEGATION_ARTIFACT_INVALID",
      path: p.dir,
    };
  }
  return { exists: true, valid: true, manifest, patch, reason: null, path: p.dir };
}

export function listDelegationArtifacts(repoRoot) {
  const p = paths(repoRoot);
  if (!existsSync(p.artifacts)) return [];
  const artifacts = [];
  for (const name of readdirSync(p.artifacts).sort()) {
    if (name.startsWith(".")) continue;
    let result;
    try {
      result = readDelegationArtifact(repoRoot, name);
    } catch {
      invalid();
    }
    if (!result.exists || !result.valid) invalid();
    artifacts.push(result.manifest);
  }
  return artifacts.sort((a, b) => a.artifactId.localeCompare(b.artifactId));
}
