import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { assertDelegationRequest } from "../../core/domain/delegation.mjs";
import {
  authorizeChangedPaths,
  normalizeMutationScope,
} from "../../core/delegation/mutation-scope.mjs";
import {
  readDelegationGitBoundary,
  readDelegationGitStdout,
  runDelegationGit,
} from "./git-boundary.mjs";
import { inspectMutableDelegationWorkspace } from "./mutable-workspace.mjs";
import { readDelegationProductFingerprint } from "./source-snapshot.mjs";
import { writeDelegationArtifact } from "./artifact-store.mjs";

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

export async function sealDelegationArtifact({
  repoRoot,
  request,
  generation,
  actor,
  workspace,
  report,
} = {}) {
  void report;
  assertDelegationRequest(request);
  if (request.schema !== "orchestra.delegation-request.v2") {
    throw lifecycleError("ARTIFACT_SEAL_FAILED", "REQUEST_VERSION_INVALID");
  }
  assertSealAuthority(request, generation, actor);

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
    ], { maxBuffer: 64 * 1024 * 1024 });
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
