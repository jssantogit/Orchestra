import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { assertDelegationRequest } from "../../core/domain/delegation.mjs";
import {
  readDelegationGitBoundary,
  runDelegationGit,
} from "./git-boundary.mjs";
import {
  materializeDelegationSourceSnapshot,
  readDelegationProductFingerprint,
  readDelegationSourceIdentity,
  workspacePrepFailure,
} from "./source-snapshot.mjs";

const activeWorktrees = new Map();

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function allocatePath(baseDir) {
  const root = resolve(baseDir ?? tmpdir());
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(root, `orchestra-delegation-${randomBytes(12).toString("hex")}`);
    if (!existsSync(candidate)) return { root, path: candidate };
  }
  throw workspacePrepFailure("WORKSPACE_PATH_UNAVAILABLE");
}

function attribution(context) {
  if (!context || typeof context.cleanupToken !== "string") return null;
  const expected = activeWorktrees.get(context.cleanupToken);
  if (!expected) return null;
  const repoRoot = resolve(context.repoRoot ?? "");
  const path = resolve(context.path ?? "");
  if (repoRoot !== expected.repoRoot || path !== expected.path) return null;
  return expected;
}

async function bestEffortRemove(repoRoot, path) {
  try {
    await runDelegationGit(repoRoot, ["worktree", "remove", "--force", path]);
    return !existsSync(path);
  } catch {
    return false;
  }
}

export async function prepareDelegationWorkspace({ repoRoot, request, baseDir = null } = {}) {
  assertDelegationRequest(request);
  if (request.schema !== "orchestra.delegation-request.v1") {
    throw workspacePrepFailure("WORKTREE_REQUEST_VERSION_INVALID");
  }
  if (!repoRoot) throw workspacePrepFailure("SOURCE_GIT_UNAVAILABLE");

  const root = resolve(repoRoot);
  const source = readDelegationSourceIdentity(root, {
    sourceRevision: request.workspace.sourceRevision,
    sourceFingerprint: request.workspace.sourceFingerprint,
  });
  const allocated = await allocatePath(baseDir);
  if (inside(root, allocated.path)) throw workspacePrepFailure("WORKSPACE_PATH_INVALID");

  let added = false;
  try {
    await runDelegationGit(root, ["worktree", "add", "--detach", allocated.path, request.workspace.sourceRevision]);
    added = true;
    await materializeDelegationSourceSnapshot({
      sourceRoot: root,
      targetRoot: allocated.path,
      source,
    });

    const initial = readDelegationProductFingerprint(allocated.path);
    if (!initial.available
        || initial.head !== request.workspace.sourceRevision
        || initial.fingerprint !== source.fingerprint) {
      throw workspacePrepFailure("WORKSPACE_IDENTITY_MISMATCH");
    }
    const canonicalGit = await readDelegationGitBoundary(root);
    if (!canonicalGit.available) throw workspacePrepFailure("SOURCE_GIT_UNAVAILABLE");

    const cleanupToken = randomBytes(32).toString("hex");
    const record = Object.freeze({
      repoRoot: root,
      path: resolve(allocated.path),
      initialFingerprint: initial.fingerprint,
      sourceFingerprint: source.fingerprint,
      canonicalGitFingerprint: canonicalGit.fingerprint,
    });
    activeWorktrees.set(cleanupToken, record);

    return {
      repoRoot: root,
      path: record.path,
      sourceRevision: request.workspace.sourceRevision,
      initialFingerprint: record.initialFingerprint,
      cleanupToken,
    };
  } catch (error) {
    if (added) await bestEffortRemove(root, allocated.path);
    if (error?.code === "WORKSPACE_PREP_FAILED") throw error;
    throw workspacePrepFailure("WORKTREE_CREATE_FAILED", error);
  }
}

export async function inspectDelegationWorkspace(context) {
  const expected = attribution(context);
  if (!expected) throw workspacePrepFailure("WORKSPACE_CONTEXT_INVALID");

  const [identity, canonicalSource, canonicalGit] = await Promise.all([
    Promise.resolve(readDelegationProductFingerprint(expected.path)),
    Promise.resolve(readDelegationProductFingerprint(expected.repoRoot)),
    readDelegationGitBoundary(expected.repoRoot),
  ]);
  if (!identity.available || !canonicalSource.available || !canonicalGit.available) {
    throw workspacePrepFailure("WORKSPACE_INSPECTION_FAILED");
  }

  const workspaceChanged = identity.fingerprint !== expected.initialFingerprint;
  const canonicalWorkspaceChanged = canonicalSource.fingerprint !== expected.sourceFingerprint;
  const canonicalGitChanged = canonicalGit.fingerprint !== expected.canonicalGitFingerprint;
  const changed = workspaceChanged || canonicalWorkspaceChanged || canonicalGitChanged;
  const dirtyFileCount = Math.max(
    workspaceChanged ? identity.dirtyFileCount : 0,
    canonicalWorkspaceChanged ? canonicalSource.dirtyFileCount : 0,
  );

  return {
    finalFingerprint: identity.fingerprint,
    dirty: changed,
    dirtyFileCount,
    canonicalWorkspaceChanged,
    canonicalGitChanged,
  };
}

export async function cleanupDelegationWorkspace(context) {
  const expected = attribution(context);
  if (!expected) {
    return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
  }

  try {
    await runDelegationGit(expected.repoRoot, ["worktree", "remove", "--force", expected.path]);
    if (existsSync(expected.path)) {
      return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
    }
    activeWorktrees.delete(context.cleanupToken);
    return { cleaned: true, reason: null };
  } catch {
    return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
  }
}
