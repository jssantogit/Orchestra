import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { assertDelegationRequest } from "../../core/domain/delegation.mjs";
import {
  authorizeChangedPaths,
  normalizeMutationScope,
} from "../../core/delegation/mutation-scope.mjs";
import { acquireAtomicLock, releaseAtomicLock } from "../../core/leases/atomic-lock.mjs";
import { readWorkLease } from "../../core/leases/work-lease-store.mjs";
import {
  readDelegationGitBoundary,
  readDelegationGitStdout,
  runDelegationGit,
} from "./git-boundary.mjs";
import { inspectMutableDelegationWorkspace } from "./mutable-workspace.mjs";
import { readDelegationProductFingerprint } from "./source-snapshot.mjs";
import {
  assertArtifactId,
  readDelegationArtifact,
  recordDelegationArtifactCleanup,
  transitionDelegationArtifactState,
  writeDelegationArtifact,
} from "./artifact-store.mjs";

const PROMOTION_LOCK_PATH = ".orchestra/state/delegation/promotion.lock";
const WORK_LEASE_CLAIM_LOCK_PATH = ".orchestra/state/work-lease.claim.lock";
const MAX_PATCH_BYTES = 64 * 1024 * 1024;

function lifecycleError(code, detail = code, cause = undefined) {
  const error = new Error(`${code}:${detail}`);
  error.code = code;
  error.reason = code;
  error.detail = detail;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function nulPaths(value) {
  return String(value ?? "").split("\0").filter(Boolean);
}

async function changedPaths(workspacePath, baselineSha) {
  const [tracked, untracked] = await Promise.all([
    readDelegationGitStdout(workspacePath, ["diff", "--name-only", "-z", baselineSha, "--"]),
    readDelegationGitStdout(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...nulPaths(tracked), ...nulPaths(untracked)])].sort();
}

async function baselineMode(workspacePath, baselineSha, path) {
  const output = await readDelegationGitStdout(workspacePath, ["ls-tree", baselineSha, "--", path]);
  const match = output.match(/^([0-7]{6})\s/);
  return match?.[1] ?? null;
}

async function assertSymlinkContained(workspacePath, absolutePath) {
  const rawTarget = await readlink(absolutePath);
  const lexicalTarget = isAbsolute(rawTarget)
    ? resolve(rawTarget)
    : resolve(dirname(absolutePath), rawTarget);
  if (!inside(workspacePath, lexicalTarget)) {
    throw lifecycleError("SCOPE_VIOLATION", "SYMLINK_EGRESS");
  }
  try {
    const resolved = await realpath(lexicalTarget);
    if (!inside(workspacePath, resolved)) {
      throw lifecycleError("SCOPE_VIOLATION", "SYMLINK_EGRESS");
    }
  } catch (error) {
    if (error?.code === "SCOPE_VIOLATION") throw error;
    if (error?.code !== "ENOENT") {
      throw lifecycleError("SCOPE_VIOLATION", "SYMLINK_EGRESS", error);
    }
  }
  return rawTarget;
}

async function mutationFact(workspacePath, baselineSha, path) {
  const absolute = resolve(workspacePath, path);
  if (!inside(workspacePath, absolute)) {
    throw lifecycleError("SCOPE_VIOLATION", "PATH_EGRESS");
  }

  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      path,
      kind: "DELETED",
      mode: await baselineMode(workspacePath, baselineSha, path),
      contentHash: null,
    };
  }

  if (stat.isSymbolicLink()) {
    const target = await assertSymlinkContained(workspacePath, absolute);
    return {
      path,
      kind: "SYMLINK",
      mode: "120000",
      contentHash: `sha256:${sha256(Buffer.from(target, "utf8"))}`,
    };
  }
  if (!stat.isFile()) {
    throw lifecycleError("SCOPE_VIOLATION", "UNSUPPORTED_MUTATION_KIND");
  }

  const bytes = await readFile(absolute);
  return {
    path,
    kind: "FILE",
    mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
    contentHash: `sha256:${sha256(bytes)}`,
  };
}

export async function deriveMutationFacts({ workspacePath, baselineSha, scope } = {}) {
  if (typeof workspacePath !== "string" || !workspacePath
      || typeof baselineSha !== "string" || !baselineSha) {
    throw lifecycleError("ARTIFACT_SEAL_FAILED", "MUTATION_CONTEXT_INVALID");
  }
  const normalizedScope = normalizeMutationScope(scope);
  const paths = await changedPaths(workspacePath, baselineSha);
  const scopeDecision = authorizeChangedPaths(paths, normalizedScope);
  if (!scopeDecision.allowed) {
    throw lifecycleError("SCOPE_VIOLATION", scopeDecision.violations.join(","));
  }

  const facts = [];
  for (const path of paths) {
    facts.push(await mutationFact(workspacePath, baselineSha, path));
  }
  facts.sort((a, b) => a.path.localeCompare(b.path));
  const mutationDigest = `sha256:${sha256(Buffer.from(JSON.stringify(facts), "utf8"))}`;
  return { changedPaths: paths, facts, mutationDigest };
}

function assertSealAuthority(request, generation, actor) {
  if (!Number.isSafeInteger(generation) || generation < 0
      || actor?.provider !== request.source.provider
      || actor?.actorIdHash !== request.source.actorIdHash
      || request.packet?.candidateGeneration !== generation) {
    throw lifecycleError("ARTIFACT_SEAL_FAILED", "CONTROL_CONTEXT_INVALID");
  }
}

function normalizeParallelBinding(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !Object.hasOwn(value, "groupId")
      || !Object.hasOwn(value, "memberId")) {
    throw lifecycleError("ARTIFACT_SEAL_FAILED", "PARALLEL_BINDING_INVALID");
  }
  try {
    assertArtifactId(value.groupId);
  } catch (error) {
    throw lifecycleError("ARTIFACT_SEAL_FAILED", "PARALLEL_BINDING_INVALID", error);
  }
  if (typeof value.memberId !== "string"
      || value.memberId.length === 0
      || value.memberId.length > 160) {
    throw lifecycleError("ARTIFACT_SEAL_FAILED", "PARALLEL_BINDING_INVALID");
  }
  return { groupId: value.groupId, memberId: value.memberId };
}

export async function sealDelegationArtifact({
  repoRoot,
  request,
  generation,
  actor,
  workspace,
  report,
  parallelBinding = null,
} = {}) {
  void report;
  assertDelegationRequest(request);
  if (request.schema !== "orchestra.delegation-request.v2") {
    throw lifecycleError("ARTIFACT_SEAL_FAILED", "REQUEST_VERSION_INVALID");
  }
  assertSealAuthority(request, generation, actor);
  const binding = normalizeParallelBinding(parallelBinding);

  try {
    const inspection = await inspectMutableDelegationWorkspace(workspace);
    if (inspection.canonicalWorkspaceChanged
        || inspection.canonicalGitChanged
        || inspection.cloneGitChanged
        || inspection.stagedByWorker) {
      throw lifecycleError("SCOPE_VIOLATION", "WORKER_BOUNDARY_MUTATION");
    }

    const scope = normalizeMutationScope(request.workspace.mutationScope);
    const derived = await deriveMutationFacts({
      workspacePath: workspace.path,
      baselineSha: workspace.syntheticBaselineSha,
      scope,
    });

    const canonicalProduct = readDelegationProductFingerprint(repoRoot);
    const [canonicalGit, cloneGit, head] = await Promise.all([
      readDelegationGitBoundary(repoRoot),
      readDelegationGitBoundary(workspace.path),
      readDelegationGitStdout(workspace.path, ["rev-parse", "HEAD"]),
    ]);
    if (!canonicalProduct.available
        || canonicalProduct.fingerprint !== request.workspace.sourceFingerprint
        || !canonicalGit.available
        || canonicalGit.fingerprint !== workspace.canonicalGitFingerprint
        || !cloneGit.available
        || cloneGit.fingerprint !== workspace.cloneGitFingerprint
        || head.trim() !== workspace.syntheticBaselineSha) {
      throw lifecycleError("SCOPE_VIOLATION", "WORKSPACE_BOUNDARY_CHANGED");
    }

    await runDelegationGit(workspace.path, ["add", "-A", "--", "."]);
    const patchText = await readDelegationGitStdout(workspace.path, [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      workspace.syntheticBaselineSha,
      "--",
    ], { maxBuffer: MAX_PATCH_BYTES });
    const patch = Buffer.from(patchText, "utf8");
    const patchSha256 = `sha256:${sha256(patch)}`;
    const artifactId = request.delegationId;
    const manifest = {
      schema: "orchestra.delegation-artifact.v1",
      artifactId,
      delegationId: request.delegationId,
      taskId: request.taskId,
      generation,
      source: {
        provider: request.source.provider,
        actorIdHash: request.source.actorIdHash,
      },
      target: {
        provider: request.target.provider,
        logicalRole: request.target.logicalRole,
      },
      sourceRevision: request.workspace.sourceRevision,
      sourceFingerprint: request.workspace.sourceFingerprint,
      canonicalGitFingerprint: workspace.canonicalGitFingerprint,
      delegatedPath: workspace.path,
      syntheticBaselineSha: workspace.syntheticBaselineSha,
      mutationScope: scope,
      changedPaths: derived.changedPaths,
      patchSha256,
      mutationDigest: derived.mutationDigest,
      state: "READY_FOR_REVIEW",
      createdAt: new Date().toISOString(),
      ...(binding === null ? {} : {
        parallelGroupId: binding.groupId,
        parallelMemberId: binding.memberId,
      }),
    };
    writeDelegationArtifact(repoRoot, { manifest, patch });
    return {
      artifactId,
      patchSha256,
      mutationDigest: derived.mutationDigest,
      changedPaths: derived.changedPaths,
      state: "READY_FOR_REVIEW",
    };
  } catch (error) {
    if (error?.code === "SCOPE_VIOLATION") throw error;
    if (error?.code === "ARTIFACT_SEAL_FAILED") throw error;
    throw lifecycleError("ARTIFACT_SEAL_FAILED", "SEAL_FAILED", error);
  }
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function validateReviewWorkspace(repoRoot, delegatedPath) {
  if (typeof delegatedPath !== "string" || !delegatedPath) {
    throw lifecycleError("ARTIFACT_TAMPERED", "REVIEW_PATH_INVALID");
  }
  const root = resolve(repoRoot);
  const workspacePath = resolve(delegatedPath);
  const scratchRoot = dirname(workspacePath);
  if (inside(root, workspacePath)
      || basename(workspacePath) !== "workspace"
      || !basename(scratchRoot).startsWith("orchestra-implementation-")) {
    throw lifecycleError("ARTIFACT_TAMPERED", "REVIEW_PATH_INVALID");
  }

  let workspaceStat;
  try {
    workspaceStat = await lstat(workspacePath);
  } catch (error) {
    throw lifecycleError("ARTIFACT_TAMPERED", "REVIEW_PATH_MISSING", error);
  }
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw lifecycleError("ARTIFACT_TAMPERED", "REVIEW_PATH_INVALID");
  }
  const [resolvedWorkspace, resolvedScratch] = await Promise.all([
    realpath(workspacePath),
    realpath(scratchRoot),
  ]);
  if (inside(root, resolvedWorkspace)
      || inside(root, resolvedScratch)
      || dirname(resolvedWorkspace) !== resolvedScratch) {
    throw lifecycleError("ARTIFACT_TAMPERED", "REVIEW_PATH_INVALID");
  }
  return { workspacePath, scratchRoot };
}

async function artifactIntegrity(repoRoot, artifactId) {
  let stored;
  try {
    stored = readDelegationArtifact(repoRoot, artifactId);
  } catch (error) {
    return {
      stored: null,
      manifest: null,
      derived: null,
      valid: false,
      reason: "ARTIFACT_TAMPERED",
      cause: error,
    };
  }
  if (!stored.exists || !stored.valid || !stored.manifest || !Buffer.isBuffer(stored.patch)) {
    return {
      stored,
      manifest: stored.manifest,
      derived: null,
      valid: false,
      reason: "ARTIFACT_TAMPERED",
    };
  }

  const manifest = stored.manifest;
  if (`sha256:${sha256(stored.patch)}` !== manifest.patchSha256) {
    return { stored, manifest, derived: null, valid: false, reason: "ARTIFACT_TAMPERED" };
  }

  if (manifest.state !== "READY_FOR_REVIEW") {
    return { stored, manifest, derived: null, valid: true, reason: null };
  }

  try {
    const { workspacePath } = await validateReviewWorkspace(repoRoot, manifest.delegatedPath);
    const head = (await readDelegationGitStdout(workspacePath, ["rev-parse", "HEAD"])).trim();
    if (head !== manifest.syntheticBaselineSha) {
      throw lifecycleError("ARTIFACT_TAMPERED", "REVIEW_HEAD_CHANGED");
    }

    const derived = await deriveMutationFacts({
      workspacePath,
      baselineSha: manifest.syntheticBaselineSha,
      scope: manifest.mutationScope,
    });
    if (!sameStrings(derived.changedPaths, manifest.changedPaths)
        || derived.mutationDigest !== manifest.mutationDigest) {
      throw lifecycleError("ARTIFACT_TAMPERED", "MUTATION_DIGEST_CHANGED");
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
      throw lifecycleError("ARTIFACT_TAMPERED", "STAGED_PATCH_CHANGED");
    }
    return { stored, manifest, derived, valid: true, reason: null };
  } catch (error) {
    return {
      stored,
      manifest,
      derived: null,
      valid: false,
      reason: "ARTIFACT_TAMPERED",
      cause: error,
    };
  }
}

export async function inspectDelegationArtifact({ repoRoot, artifactId } = {}) {
  const checked = await artifactIntegrity(repoRoot, artifactId);
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

function currentWorkLeaseDecision(repoRoot, manifest, generation, actor) {
  const current = readWorkLease(repoRoot);
  if (!current.exists) {
    // Explicit session-authority rollback can legitimately have no neutral lease.
    // In normal 1.x lease mode, any existing neutral lease is authoritative below.
    return { allowed: true, reason: null };
  }
  if (!current.valid || !current.lease) {
    return { allowed: false, reason: "CAPABILITY_DENIED" };
  }

  const lease = current.lease;
  if (lease.generation !== generation || lease.generation !== manifest?.generation) {
    return { allowed: false, reason: "PROMOTION_STALE" };
  }
  if (lease.actor?.provider !== actor?.provider
      || lease.actor?.sessionIdHash !== actor?.actorIdHash
      || lease.actor?.provider !== manifest?.source?.provider
      || lease.actor?.sessionIdHash !== manifest?.source?.actorIdHash
      || !Array.isArray(lease.capabilities)
      || !lease.capabilities.includes("CONTROL")) {
    return { allowed: false, reason: "CAPABILITY_DENIED" };
  }
  return { allowed: true, reason: null };
}

function promotionLockPath(repoRoot) {
  return join(resolve(repoRoot), PROMOTION_LOCK_PATH);
}

function workLeaseClaimLockPath(repoRoot) {
  return join(resolve(repoRoot), WORK_LEASE_CLAIM_LOCK_PATH);
}

function acquireArtifactLock(repoRoot, artifactId, actor) {
  return acquireAtomicLock(promotionLockPath(repoRoot), {
    ownerIdHash: `${actor?.actorIdHash ?? "unknown"}:${artifactId ?? "unknown"}`,
    staleAfterMs: 30_000,
  });
}

function acquireWorkLeaseFence(repoRoot, artifactId, actor) {
  return acquireAtomicLock(workLeaseClaimLockPath(repoRoot), {
    ownerIdHash: `${actor?.actorIdHash ?? "unknown"}:${artifactId ?? "unknown"}:artifact-control`,
    staleAfterMs: 30_000,
  });
}

async function cleanupRetainedWorkspace(repoRoot, delegatedPath) {
  try {
    const { scratchRoot } = await validateReviewWorkspace(repoRoot, delegatedPath);
    await rm(scratchRoot, { recursive: true, force: true });
    return { cleaned: true, reason: null };
  } catch (error) {
    return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED", error };
  }
}

function cleanupState(cleanup, recoverablePath) {
  return cleanup?.cleaned === true
    ? { cleaned: true, reason: null, recoverablePath: null }
    : { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED", recoverablePath };
}

function persistCleanupState(repoRoot, artifactId, cleanup, recoverablePath) {
  const update = recordDelegationArtifactCleanup(
    repoRoot,
    artifactId,
    cleanupState(cleanup, recoverablePath),
  );
  return update.updated
    ? cleanup
    : { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
}

async function canonicalStillAtArtifactBaseline(repoRoot, manifest) {
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

async function canonicalFactForExpected(repoRoot, manifest, expected) {
  if (expected.kind === "DELETED") {
    try {
      await lstat(resolve(repoRoot, expected.path));
      throw lifecycleError("PROMOTION_FAILED", "DELETED_PATH_STILL_PRESENT");
    } catch (error) {
      if (error?.code === "PROMOTION_FAILED") throw error;
      if (error?.code !== "ENOENT") throw error;
      return { ...expected };
    }
  }
  return mutationFact(repoRoot, manifest.sourceRevision, expected.path);
}

async function verifyPromotedMutation(repoRoot, manifest, expectedFacts) {
  const actualFacts = [];
  for (const expected of expectedFacts) {
    actualFacts.push(await canonicalFactForExpected(repoRoot, manifest, expected));
  }
  actualFacts.sort((a, b) => a.path.localeCompare(b.path));
  const digest = `sha256:${sha256(Buffer.from(JSON.stringify(actualFacts), "utf8"))}`;
  return digest === manifest.mutationDigest;
}

async function rollbackAppliedPatch(repoRoot, patchPath, sourceFingerprint, indexPatch) {
  try {
    await runDelegationGit(repoRoot, ["apply", "--reverse", patchPath], { maxBuffer: MAX_PATCH_BYTES });
    const [product, currentIndex] = await Promise.all([
      Promise.resolve(readDelegationProductFingerprint(repoRoot)),
      readCanonicalIndexPatch(repoRoot),
    ]);
    return product.available
      && product.fingerprint === sourceFingerprint
      && currentIndex === indexPatch;
  } catch {
    return false;
  }
}

export async function promoteDelegationArtifact({
  repoRoot,
  artifactId,
  generation,
  actor,
  cleanupWorkspace = cleanupRetainedWorkspace,
} = {}) {
  const lock = acquireArtifactLock(repoRoot, artifactId, actor);
  if (!lock.acquired) {
    return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
  }
  const leaseFence = acquireWorkLeaseFence(repoRoot, artifactId, actor);
  if (!leaseFence.acquired) {
    releaseAtomicLock(lock.handle);
    return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
  }

  let patchApplied = false;
  let indexBefore = null;
  let sourceFingerprint = null;
  let patchPath = null;
  try {
    const stored = readDelegationArtifact(repoRoot, artifactId);
    if (stored.exists
        && stored.valid
        && stored.manifest?.parallelGroupId
        && stored.manifest?.parallelMemberId) {
      return { promoted: false, reason: "CAPABILITY_DENIED", changedPaths: [] };
    }

    const checked = await artifactIntegrity(repoRoot, artifactId);
    const manifest = checked.manifest;
    if (!manifest || manifest.state !== "READY_FOR_REVIEW") {
      return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
    }
    if (!validControlAuthority(manifest, generation, actor)) {
      return { promoted: false, reason: "CAPABILITY_DENIED", changedPaths: [] };
    }
    const leaseDecision = currentWorkLeaseDecision(repoRoot, manifest, generation, actor);
    if (!leaseDecision.allowed) {
      return { promoted: false, reason: leaseDecision.reason, changedPaths: [] };
    }
    if (!checked.valid || !checked.derived) {
      return { promoted: false, reason: "ARTIFACT_TAMPERED", changedPaths: [] };
    }
    if (!(await canonicalStillAtArtifactBaseline(repoRoot, manifest))) {
      return { promoted: false, reason: "PROMOTION_STALE", changedPaths: [] };
    }

    const patch = checked.stored.patch;
    patchPath = join(checked.stored.path, "candidate.patch");
    if (!Buffer.isBuffer(patch) || patch.length > MAX_PATCH_BYTES) {
      return { promoted: false, reason: "ARTIFACT_TAMPERED", changedPaths: [] };
    }
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
    const mutationMatches = indexAfter === indexBefore
      && await verifyPromotedMutation(repoRoot, manifest, checked.derived.facts);
    if (!mutationMatches) {
      const rolledBack = await rollbackAppliedPatch(
        repoRoot,
        patchPath,
        sourceFingerprint,
        indexBefore,
      );
      patchApplied = !rolledBack;
      return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
    }

    const transition = transitionDelegationArtifactState(repoRoot, artifactId, {
      expectedState: "READY_FOR_REVIEW",
      nextState: "PROMOTED",
      cleanup: {
        cleaned: false,
        reason: "WORKSPACE_CLEANUP_FAILED",
        recoverablePath: manifest.delegatedPath,
      },
    });
    if (!transition.transitioned) {
      const rolledBack = await rollbackAppliedPatch(
        repoRoot,
        patchPath,
        sourceFingerprint,
        indexBefore,
      );
      patchApplied = !rolledBack;
      return { promoted: false, reason: "PROMOTION_FAILED", changedPaths: [] };
    }
    patchApplied = false;

    const cleanup = persistCleanupState(
      repoRoot,
      artifactId,
      await cleanupWorkspace(repoRoot, manifest.delegatedPath),
      manifest.delegatedPath,
    );
    return {
      promoted: true,
      reason: cleanup.cleaned ? null : cleanup.reason,
      changedPaths: [...manifest.changedPaths],
    };
  } finally {
    if (patchApplied && patchPath && sourceFingerprint && indexBefore !== null) {
      await rollbackAppliedPatch(repoRoot, patchPath, sourceFingerprint, indexBefore);
    }
    releaseAtomicLock(leaseFence.handle);
    releaseAtomicLock(lock.handle);
  }
}

export async function discardDelegationArtifact({
  repoRoot,
  artifactId,
  generation,
  actor,
  cleanupWorkspace = cleanupRetainedWorkspace,
} = {}) {
  const lock = acquireArtifactLock(repoRoot, artifactId, actor);
  if (!lock.acquired) return { discarded: false, reason: "PROMOTION_FAILED" };
  const leaseFence = acquireWorkLeaseFence(repoRoot, artifactId, actor);
  if (!leaseFence.acquired) {
    releaseAtomicLock(lock.handle);
    return { discarded: false, reason: "PROMOTION_FAILED" };
  }

  try {
    const checked = await artifactIntegrity(repoRoot, artifactId);
    const manifest = checked.manifest;
    if (!manifest || manifest.state !== "READY_FOR_REVIEW") {
      return { discarded: false, reason: "PROMOTION_FAILED" };
    }
    if (!validControlAuthority(manifest, generation, actor)) {
      return { discarded: false, reason: "CAPABILITY_DENIED" };
    }
    const leaseDecision = currentWorkLeaseDecision(repoRoot, manifest, generation, actor);
    if (!leaseDecision.allowed) {
      return { discarded: false, reason: leaseDecision.reason };
    }
    if (!checked.valid || !checked.derived) {
      return { discarded: false, reason: "ARTIFACT_TAMPERED" };
    }

    const transition = transitionDelegationArtifactState(repoRoot, artifactId, {
      expectedState: "READY_FOR_REVIEW",
      nextState: "DISCARDED",
      cleanup: {
        cleaned: false,
        reason: "WORKSPACE_CLEANUP_FAILED",
        recoverablePath: manifest.delegatedPath,
      },
    });
    if (!transition.transitioned) return { discarded: false, reason: "PROMOTION_FAILED" };

    const cleanup = persistCleanupState(
      repoRoot,
      artifactId,
      await cleanupWorkspace(repoRoot, manifest.delegatedPath),
      manifest.delegatedPath,
    );
    return { discarded: true, reason: cleanup.cleaned ? null : cleanup.reason };
  } finally {
    releaseAtomicLock(leaseFence.handle);
    releaseAtomicLock(lock.handle);
  }
}
