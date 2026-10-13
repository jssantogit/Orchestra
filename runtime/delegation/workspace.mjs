import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { assertDelegationRequest } from "../../core/domain/delegation.mjs";
import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";

const SAFE_DELEGATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function isWithin(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function prepError(detail, cause = null) {
  const error = new Error(`WORKSPACE_PREP_FAILED:${detail}`);
  error.code = "WORKSPACE_PREP_FAILED";
  error.detail = detail;
  if (cause) error.cause = cause;
  return error;
}

function exactCleanupAllowed(context) {
  const path = resolve(context?.path || "");
  const repoRoot = resolve(context?.repoRoot || "");
  const token = context?.cleanupToken;
  return Boolean(
    context?.delegationId
    && SAFE_DELEGATION_ID.test(context.delegationId)
    && token
    && token.delegationId === context.delegationId
    && resolve(token.path || "") === path
    && path !== repoRoot
    && !isWithin(path, repoRoot)
  );
}

function removeExactWorktree(context) {
  if (!exactCleanupAllowed(context)) return false;
  if (!existsSync(context.path)) return true;
  try {
    git(context.repoRoot, ["worktree", "remove", "--force", context.path]);
    return !existsSync(context.path);
  } catch {
    return false;
  }
}

export function prepareDelegationWorkspace({ repoRoot, request, baseDir = null }) {
  try {
    assertDelegationRequest(request);
  } catch (error) {
    throw prepError("INVALID_DELEGATION_REQUEST", error);
  }

  if (!SAFE_DELEGATION_ID.test(request.delegationId)) {
    throw prepError("INVALID_DELEGATION_ID");
  }

  const root = resolve(repoRoot);
  const identity = readWorkspaceFingerprint(root);
  if (!identity.available) throw prepError("SOURCE_WORKSPACE_UNAVAILABLE");
  if (identity.dirtyFileCount !== 0) throw prepError("SOURCE_WORKSPACE_DIRTY");
  if (identity.fingerprint !== request.workspace.sourceFingerprint) {
    throw prepError("SOURCE_FINGERPRINT_MISMATCH");
  }

  let resolvedRevision;
  try {
    resolvedRevision = git(root, ["rev-parse", "--verify", `${request.workspace.sourceRevision}^{commit}`]);
  } catch (error) {
    throw prepError("SOURCE_REVISION_MISMATCH", error);
  }
  if (!resolvedRevision || resolvedRevision !== identity.head) {
    throw prepError("SOURCE_REVISION_MISMATCH");
  }

  const externalBase = resolve(baseDir || join(tmpdir(), "orchestra-delegations"));
  if (isWithin(externalBase, root)) throw prepError("BASE_DIR_INSIDE_SOURCE");

  const workspacePath = resolve(externalBase, request.delegationId);
  if (!isWithin(workspacePath, externalBase) || isWithin(workspacePath, root)) {
    throw prepError("WORKSPACE_PATH_ESCAPE");
  }
  if (existsSync(workspacePath)) throw prepError("WORKSPACE_PATH_EXISTS");

  mkdirSync(externalBase, { recursive: true });
  const context = {
    delegationId: request.delegationId,
    repoRoot: root,
    path: workspacePath,
    sourceRevision: resolvedRevision,
    cleanupToken: {
      delegationId: request.delegationId,
      path: workspacePath,
    },
  };

  try {
    git(root, ["worktree", "add", "--detach", workspacePath, resolvedRevision]);
  } catch (error) {
    removeExactWorktree(context);
    throw prepError("WORKTREE_CREATE_FAILED", error);
  }

  const initial = readWorkspaceFingerprint(workspacePath);
  if (!initial.available) {
    removeExactWorktree(context);
    throw prepError("WORKTREE_FINGERPRINT_UNAVAILABLE");
  }

  return {
    ...context,
    initialFingerprint: initial.fingerprint,
  };
}

export function inspectDelegationWorkspace(context) {
  const fingerprint = readWorkspaceFingerprint(context.path);
  if (!fingerprint.available) {
    const error = new Error("WORKSPACE_INSPECTION_FAILED");
    error.code = "WORKSPACE_INSPECTION_FAILED";
    throw error;
  }
  return {
    finalFingerprint: fingerprint.fingerprint,
    dirty: fingerprint.dirtyFileCount > 0,
    dirtyFileCount: fingerprint.dirtyFileCount,
  };
}

export function cleanupDelegationWorkspace(context) {
  if (!exactCleanupAllowed(context)) {
    return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
  }
  if (!existsSync(context.path)) return { cleaned: true, reason: null };
  return removeExactWorktree(context)
    ? { cleaned: true, reason: null }
    : { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
}
