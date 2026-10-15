import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { acquireAtomicLock, releaseAtomicLock } from "../../core/leases/atomic-lock.mjs";
import { readWorkLease } from "../../core/leases/work-lease-store.mjs";
import {
  deriveMutationFacts,
} from "./artifact-lifecycle.mjs";
import {
  readCompositeArtifact,
  recordCompositeArtifactCleanup,
  transitionCompositeArtifactState,
} from "./composite-artifact-store.mjs";
import {
  readDelegationGitBoundary,
  readDelegationGitStdout,
  runDelegationGit,
} from "./git-boundary.mjs";
import {
  readParallelGroup,
  transitionParallelGroupState,
} from "./parallel-group-store.mjs";
import { readDelegationProductFingerprint } from "./source-snapshot.mjs";

const PROMOTION_LOCK_PATH = ".orchestra/state/delegation/promotion.lock";
const WORK_LEASE_CLAIM_LOCK_PATH = ".orchestra/state/work-lease.claim.lock";
const MAX_PATCH_BYTES = 64 * 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function validateReviewWorkspace(repoRoot, delegatedPath) {
  if (typeof delegatedPath !== "string" || !delegatedPath) throw new Error("COMPOSITE_REVIEW_PATH_INVALID");
  const root = resolve(repoRoot);
  const workspacePath = resolve(delegatedPath);
  const scratchRoot = dirname(workspacePath);
  if (inside(root, workspacePath)
      || basename(workspacePath) !== "workspace"
      || !basename(scratchRoot).startsWith("orchestra-implementation-")) {
    throw new Error("COMPOSITE_REVIEW_PATH_INVALID");
  }
  const stat = await lstat(workspacePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("COMPOSITE_REVIEW_PATH_INVALID");
  const [resolvedWorkspace, resolvedScratch] = await Promise.all([
    realpath(workspacePath),
    realpath(scratchRoot),
  ]);
  if (inside(root, resolvedWorkspace)
      || inside(root, resolvedScratch)
      || dirname(resolvedWorkspace) !== resolvedScratch) {
    throw new Error("COMPOSITE_REVIEW_PATH_INVALID");
  }
  return { workspacePath, scratchRoot };
}

function groupMatchesManifest(groupState, manifest) {
  const record = groupState?.record;
  return groupState?.exists === true
    && groupState.valid === true
    && record?.state === "READY_FOR_REVIEW"
    && record.group?.groupId === manifest.groupId
    && record.group?.taskId === manifest.taskId
    && record.group?.generation === manifest.generation
    && record.compositeArtifactId === manifest.artifactId
    && sameStrings([...record.memberArtifactIds].sort(), [...manifest.memberArtifactIds].sort());
}

async function compositeIntegrity(repoRoot, artifactId) {
  let stored;
  try {
    stored = readCompositeArtifact(repoRoot, artifactId);
  } catch {
    return { stored: null, manifest: null, derived: null, valid: false, reason: "ARTIFACT_TAMPERED" };
  }
  if (!stored.exists || !stored.valid || !stored.manifest || !Buffer.isBuffer(stored.patch)) {
    return { stored, manifest: stored.manifest, derived: null, valid: false, reason: "ARTIFACT_TAMPERED" };
  }
  const manifest = stored.manifest;
  if (`sha256:${sha256(stored.patch)}` !== manifest.patchSha256) {
    return { stored, manifest, derived: null, valid: false, reason: "ARTIFACT_TAMPERED" };
  }
  if (manifest.state !== "READY_FOR_REVIEW") {
    return { stored, manifest, derived: null, valid: true, reason: null };
  }
  try {
    const groupState = readParallelGroup(repoRoot, manifest.groupId);
    if (!groupMatchesManifest(groupState, manifest)) throw new Error("GROUP_STATE_MISMATCH");
    const { workspacePath } = await validateReviewWorkspace(repoRoot, manifest.delegatedPath);
    const head = (await readDelegationGitStdout(workspacePath, ["rev-parse", "HEAD"])).trim();
    if (head !== manifest.syntheticBaselineSha) throw new Error("REVIEW_HEAD_CHANGED");
    const derived = await deriveMutationFacts({
      workspacePath,
      baselineSha: manifest.syntheticBaselineSha,
      scope: { allowedPaths: ["**"], forbiddenPaths: [] },
    });
    if (!sameStrings(derived.changedPaths, manifest.changedPaths)
        || derived.mutationDigest !== manifest.mutationDigest) {
      throw new Error("MUTATION_DIGEST_CHANGED");
    }
    const stagedPatch = await readDelegationGitStdout(workspacePath, [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      manifest.syntheticBaselineSha,
      "--",
    ], { maxBuffer: MAX_PATCH_BYTES });
    if (`sha256:${sha256(Buffer.from(stagedPatch, "utf8"))}` !== manifest.patchSha256) {
      throw new Error("STAGED_PATCH_CHANGED");
    }
    return { stored, manifest, derived, valid: true, reason: null, groupState };
  } catch {
    return { stored, manifest, derived: null, valid: false, reason: "ARTIFACT_TAMPERED" };
  }
}

export async function inspectCompositeArtifact({ repoRoot, artifactId } = {}) {
  const checked = await compositeIntegrity(repoRoot, artifactId);
  return {
    manifest: checked.manifest,
    integrity: { valid: checked.valid, reason: checked.reason },
    reviewPath: checked.manifest?.delegatedPath ?? null,
  };
}

function validControlAuthority(manifest, generation, actor) {
  return manifest
    && Number.isSafeInteger(generation)
    && generation >= 0
    && generation === manifest.generation
    && actor?.isRoot === true
    && actor?.provider === manifest.source.provider
    && actor?.actorIdHash === manifest.source.actorIdHash;
}

function leaseDecision(repoRoot, manifest, generation, actor) {
  const current = readWorkLease(repoRoot);
  if (!current.exists || !current.valid || !current.lease) {
    return { allowed: false, reason: "CAPABILITY_DENIED" };
  }
  const lease = current.lease;
  if (lease.generation !== generation || lease.generation !== manifest.generation) {
    return { allowed: false, reason: "PROMOTION_STALE" };
  }
  if (lease.taskId !== manifest.taskId
      || lease.actor?.provider !== actor?.provider
      || lease.actor?.sessionIdHash !== actor?.actorIdHash
      || !Array.isArray(lease.capabilities)
      || !lease.capabilities.includes("CONTROL")) {
    return { allowed: false, reason: "CAPABILITY_DENIED" };
  }
  return { allowed: true, reason: null };
}

function acquirePromotionLocks(repoRoot, artifactId, actor) {
  const promotion = acquireAtomicLock(join(resolve(repoRoot), PROMOTION_LOCK_PATH), {
    ownerIdHash: `${actor?.actorIdHash ?? "unknown"}:${artifactId ?? "unknown"}`,
    staleAfterMs: 30_000,
  });
  if (!promotion.acquired) return { acquired: false, promotion: null, leaseFence: null };
  const leaseFence = acquireAtomicLock(join(resolve(repoRoot), WORK_LEASE_CLAIM_LOCK_PATH), {
    ownerIdHash: `${actor?.actorIdHash ?? "unknown"}:${artifactId ?? "unknown"}:composite-control`,
    staleAfterMs: 30_000,
  });
  if (!leaseFence.acquired) {
    releaseAtomicLock(promotion.handle);
    return { acquired: false, promotion: null, leaseFence: null };
  }
  return { acquired: true, promotion, leaseFence };
}

function releasePromotionLocks(locks) {
  if (locks?.leaseFence?.handle) releaseAtomicLock(locks.leaseFence.handle);
  if (locks?.promotion?.handle) releaseAtomicLock(locks.promotion.handle);
}

async function canonicalAtBaseline(repoRoot, manifest) {
  const product = readDelegationProductFingerprint(repoRoot);
  const gitBoundary = await readDelegationGitBoundary(repoRoot);
  return product.available
    && product.fingerprint === manifest.sourceFingerprint
    && gitBoundary.available
    && gitBoundary.fingerprint === manifest.canonicalGitFingerprint;
}

async function readCanonicalIndexPatch(repoRoot) {
  return readDelegationGitStdout(repoRoot, [
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "HEAD",
    "--",
  ], { maxBuffer: MAX_PATCH_BYTES });
}

async function baselineMode(repoRoot, baselineSha, path) {
  const output = await readDelegationGitStdout(repoRoot, ["ls-tree", baselineSha, "--", path]);
  const match = output.match(/^([0-7]{6})\s/);
  return match?.[1] ?? null;
}

async function factForPath(repoRoot, baselineSha, path) {
  const absolute = resolve(repoRoot, path);
  if (!inside(repoRoot, absolute)) throw new Error("PATH_EGRESS");
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { path, kind: "DELETED", mode: await baselineMode(repoRoot, baselineSha, path), contentHash: null };
  }
  if (stat.isSymbolicLink()) {
    const target = await readlink(absolute);
    const lexical = isAbsolute(target) ? resolve(target) : resolve(dirname(absolute), target);
    if (!inside(repoRoot, lexical)) throw new Error("SYMLINK_EGRESS");
    return {
      path,
      kind: "SYMLINK",
      mode: "120000",
      contentHash: `sha256:${sha256(Buffer.from(target, "utf8"))}`,
    };
  }
  if (!stat.isFile()) throw new Error("UNSUPPORTED_MUTATION_KIND");
  const bytes = await readFile(absolute);
  return {
    path,
    kind: "FILE",
    mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
    contentHash: `sha256:${sha256(bytes)}`,
  };
}

async function verifyAppliedMutation(repoRoot, manifest, expectedFacts) {
  const facts = [];
  for (const expected of expectedFacts) facts.push(await factForPath(repoRoot, manifest.sourceRevision, expected.path));
  facts.sort((a, b) => a.path.localeCompare(b.path));
  return `sha256:${sha256(Buffer.from(JSON.stringify(facts), "utf8"))}` === manifest.mutationDigest;
}

async function rollbackPatch(repoRoot, patchPath, sourceFingerprint, indexBefore) {
  try {
    await runDelegationGit(repoRoot, ["apply", "--reverse", patchPath], { maxBuffer: MAX_PATCH_BYTES });
    const [product, indexAfter] = await Promise.all([
      Promise.resolve(readDelegationProductFingerprint(repoRoot)),
      readCanonicalIndexPatch(repoRoot),
    ]);
    return product.available && product.fingerprint === sourceFingerprint && indexAfter === indexBefore;
  } catch {
    return false;
  }
}

async function cleanupReview(repoRoot, delegatedPath) {
  try {
    const { scratchRoot } = await validateReviewWorkspace(repoRoot, delegatedPath);
    await rm(scratchRoot, { recursive: true, force: true });
    return { cleaned: true, reason: null };
  } catch {
    return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
  }
}

function cleanupRecord(cleanup, recoverablePath) {
  return cleanup.cleaned
    ? { cleaned: true, reason: null, recoverablePath: null }
    : { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED", recoverablePath };
}

export async function promoteCompositeArtifact({ repoRoot, artifactId, generation, actor } = {}) {
  const locks = acquirePromotionLocks(repoRoot, artifactId, actor);
  if (!locks.acquired) return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
  let patchApplied = false;
  let patchPath = null;
  let indexBefore = null;
  let sourceFingerprint = null;
  try {
    const checked = await compositeIntegrity(repoRoot, artifactId);
    const manifest = checked.manifest;
    if (!manifest || manifest.state !== "READY_FOR_REVIEW") {
      return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
    }
    if (!validControlAuthority(manifest, generation, actor)) {
      return { promoted: false, reason: "CAPABILITY_DENIED", changedPaths: [] };
    }
    const lease = leaseDecision(repoRoot, manifest, generation, actor);
    if (!lease.allowed) return { promoted: false, reason: lease.reason, changedPaths: [] };
    if (!checked.valid || !checked.derived) {
      return { promoted: false, reason: "ARTIFACT_TAMPERED", changedPaths: [] };
    }
    if (!(await canonicalAtBaseline(repoRoot, manifest))) {
      return { promoted: false, reason: "PROMOTION_STALE", changedPaths: [] };
    }

    patchPath = join(checked.stored.path, "candidate.patch");
    indexBefore = await readCanonicalIndexPatch(repoRoot);
    sourceFingerprint = manifest.sourceFingerprint;
    try {
      await runDelegationGit(repoRoot, ["apply", "--check", patchPath], { maxBuffer: MAX_PATCH_BYTES });
      await runDelegationGit(repoRoot, ["apply", patchPath], { maxBuffer: MAX_PATCH_BYTES });
      patchApplied = true;
    } catch {
      return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
    }

    const indexAfter = await readCanonicalIndexPatch(repoRoot);
    if (indexAfter !== indexBefore || !(await verifyAppliedMutation(repoRoot, manifest, checked.derived.facts))) {
      const rolledBack = await rollbackPatch(repoRoot, patchPath, sourceFingerprint, indexBefore);
      patchApplied = !rolledBack;
      return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
    }

    const artifactTransition = transitionCompositeArtifactState(repoRoot, artifactId, {
      expectedState: "READY_FOR_REVIEW",
      nextState: "PROMOTED",
      cleanup: { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED", recoverablePath: manifest.delegatedPath },
    });
    if (!artifactTransition.transitioned) {
      const rolledBack = await rollbackPatch(repoRoot, patchPath, sourceFingerprint, indexBefore);
      patchApplied = !rolledBack;
      return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
    }
    const groupTransition = transitionParallelGroupState(repoRoot, manifest.groupId, {
      expectedState: "READY_FOR_REVIEW",
      nextState: "PROMOTED",
      memberArtifactIds: [...manifest.memberArtifactIds],
      compositeArtifactId: artifactId,
    });
    if (!groupTransition.transitioned) {
      const rolledBack = await rollbackPatch(repoRoot, patchPath, sourceFingerprint, indexBefore);
      patchApplied = !rolledBack;
      return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
    }
    patchApplied = false;

    const cleanup = await cleanupReview(repoRoot, manifest.delegatedPath);
    recordCompositeArtifactCleanup(repoRoot, artifactId, cleanupRecord(cleanup, manifest.delegatedPath));
    return {
      promoted: true,
      reason: cleanup.cleaned ? null : cleanup.reason,
      changedPaths: [...manifest.changedPaths],
    };
  } finally {
    if (patchApplied && patchPath && sourceFingerprint && indexBefore !== null) {
      await rollbackPatch(repoRoot, patchPath, sourceFingerprint, indexBefore);
    }
    releasePromotionLocks(locks);
  }
}

export async function discardCompositeArtifact({ repoRoot, artifactId, generation, actor } = {}) {
  const locks = acquirePromotionLocks(repoRoot, artifactId, actor);
  if (!locks.acquired) return { discarded: false, reason: "PROMOTION_FAILED" };
  try {
    const checked = await compositeIntegrity(repoRoot, artifactId);
    const manifest = checked.manifest;
    if (!manifest || manifest.state !== "READY_FOR_REVIEW") return { discarded: false, reason: "PROMOTION_FAILED" };
    if (!validControlAuthority(manifest, generation, actor)) return { discarded: false, reason: "CAPABILITY_DENIED" };
    const lease = leaseDecision(repoRoot, manifest, generation, actor);
    if (!lease.allowed) return { discarded: false, reason: lease.reason };
    if (!checked.valid || !checked.derived) return { discarded: false, reason: "ARTIFACT_TAMPERED" };

    const artifactTransition = transitionCompositeArtifactState(repoRoot, artifactId, {
      expectedState: "READY_FOR_REVIEW",
      nextState: "DISCARDED",
      cleanup: { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED", recoverablePath: manifest.delegatedPath },
    });
    if (!artifactTransition.transitioned) return { discarded: false, reason: "PROMOTION_FAILED" };
    const groupTransition = transitionParallelGroupState(repoRoot, manifest.groupId, {
      expectedState: "READY_FOR_REVIEW",
      nextState: "DISCARDED",
      memberArtifactIds: [...manifest.memberArtifactIds],
      compositeArtifactId: artifactId,
    });
    if (!groupTransition.transitioned) return { discarded: false, reason: "PROMOTION_FAILED" };

    const cleanup = await cleanupReview(repoRoot, manifest.delegatedPath);
    recordCompositeArtifactCleanup(repoRoot, artifactId, cleanupRecord(cleanup, manifest.delegatedPath));
    return { discarded: true, reason: cleanup.cleaned ? null : cleanup.reason };
  } finally {
    releasePromotionLocks(locks);
  }
}
