import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { assertDelegationRequest } from "../../core/domain/delegation.mjs";
import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";

const execFileAsync = promisify(execFile);
const PRODUCT_FINGERPRINT_EXCLUDES = Object.freeze([".orchestra/state/**"]);
const activeWorktrees = new Map();

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function prepFailure(reason, cause = undefined) {
  const error = new Error(`WORKSPACE_PREP_FAILED:${reason}`);
  error.code = "WORKSPACE_PREP_FAILED";
  error.reason = reason;
  if (cause !== undefined) error.cause = cause;
  return error;
}

async function git(cwd, args) {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function gitStdout(cwd, args) {
  const result = await git(cwd, args);
  return String(result.stdout ?? "");
}

function readProductFingerprint(repoRoot) {
  return readWorkspaceFingerprint(repoRoot, {
    excludedPaths: PRODUCT_FINGERPRINT_EXCLUDES,
  });
}

function productPathspecs() {
  return [
    ".",
    ...PRODUCT_FINGERPRINT_EXCLUDES.map((path) => `:(exclude)${path}`),
  ];
}

function sourceIdentity(repoRoot, request) {
  const identity = readProductFingerprint(repoRoot);
  if (!identity.available) throw prepFailure("SOURCE_GIT_UNAVAILABLE");
  if (identity.head !== request.workspace.sourceRevision) {
    throw prepFailure("SOURCE_REVISION_MISMATCH");
  }
  if (identity.fingerprint !== request.workspace.sourceFingerprint) {
    if (identity.dirtyFileCount !== 0) throw prepFailure("SOURCE_WORKSPACE_DIRTY");
    throw prepFailure("SOURCE_FINGERPRINT_MISMATCH");
  }
  return identity;
}

async function allocatePath(baseDir) {
  const root = resolve(baseDir ?? tmpdir());
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(root, `orchestra-delegation-${randomBytes(12).toString("hex")}`);
    if (!existsSync(candidate)) return { root, path: candidate };
  }
  throw prepFailure("WORKSPACE_PATH_UNAVAILABLE");
}

function nulPaths(value) {
  return String(value ?? "").split("\0").filter(Boolean);
}

async function copyUntrackedPath(sourceRoot, targetRoot, relPath) {
  const source = resolve(sourceRoot, relPath);
  const target = resolve(targetRoot, relPath);
  if (!inside(sourceRoot, source) || !inside(targetRoot, target)) {
    throw prepFailure("WORKSPACE_SNAPSHOT_PATH_INVALID");
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

async function materializeSourceSnapshot(sourceRoot, targetRoot, source) {
  if (source.dirtyFileCount === 0) return;

  const scratch = await mkdtemp(join(tmpdir(), "orchestra-delegation-snapshot-"));
  const cachedPatchPath = join(scratch, "cached.patch");
  const unstagedPatchPath = join(scratch, "unstaged.patch");
  const specs = productPathspecs();

  try {
    const cachedPatch = await gitStdout(sourceRoot, [
      "diff", "--cached", "--binary", "HEAD", "--", ...specs,
    ]);
    const unstagedPatch = await gitStdout(sourceRoot, [
      "diff", "--binary", "--", ...specs,
    ]);
    const untracked = nulPaths(await gitStdout(sourceRoot, [
      "ls-files", "--others", "--exclude-standard", "-z", "--", ...specs,
    ]));

    if (cachedPatch.length > 0) {
      await writeFile(cachedPatchPath, cachedPatch, "utf8");
      await git(targetRoot, ["apply", "--index", "--binary", cachedPatchPath]);
    }
    if (unstagedPatch.length > 0) {
      await writeFile(unstagedPatchPath, unstagedPatch, "utf8");
      await git(targetRoot, ["apply", "--binary", unstagedPatchPath]);
    }
    for (const relPath of untracked) {
      await copyUntrackedPath(sourceRoot, targetRoot, relPath);
    }

    const sourceAfter = readProductFingerprint(sourceRoot);
    if (!sourceAfter.available || sourceAfter.fingerprint !== source.fingerprint) {
      throw prepFailure("SOURCE_CHANGED_DURING_SNAPSHOT");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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
    await git(repoRoot, ["worktree", "remove", "--force", path]);
    return !existsSync(path);
  } catch {
    return false;
  }
}

export async function prepareDelegationWorkspace({ repoRoot, request, baseDir = null } = {}) {
  assertDelegationRequest(request);
  if (!repoRoot) throw prepFailure("SOURCE_GIT_UNAVAILABLE");

  const root = resolve(repoRoot);
  const source = sourceIdentity(root, request);
  const allocated = await allocatePath(baseDir);
  if (inside(root, allocated.path)) throw prepFailure("WORKSPACE_PATH_INVALID");

  let added = false;
  try {
    await git(root, ["worktree", "add", "--detach", allocated.path, request.workspace.sourceRevision]);
    added = true;
    await materializeSourceSnapshot(root, allocated.path, source);

    const initial = readProductFingerprint(allocated.path);
    if (!initial.available
        || initial.head !== request.workspace.sourceRevision
        || initial.fingerprint !== source.fingerprint) {
      throw prepFailure("WORKSPACE_IDENTITY_MISMATCH");
    }

    const cleanupToken = randomBytes(32).toString("hex");
    const record = Object.freeze({ repoRoot: root, path: resolve(allocated.path) });
    activeWorktrees.set(cleanupToken, record);

    return {
      repoRoot: root,
      path: record.path,
      sourceRevision: request.workspace.sourceRevision,
      initialFingerprint: initial.fingerprint,
      cleanupToken,
    };
  } catch (error) {
    if (added) await bestEffortRemove(root, allocated.path);
    if (error?.code === "WORKSPACE_PREP_FAILED") throw error;
    throw prepFailure("WORKTREE_CREATE_FAILED", error);
  }
}

export async function inspectDelegationWorkspace(context) {
  if (!attribution(context)) throw prepFailure("WORKSPACE_CONTEXT_INVALID");
  const identity = readProductFingerprint(context.path);
  if (!identity.available) throw prepFailure("WORKSPACE_INSPECTION_FAILED");
  return {
    finalFingerprint: identity.fingerprint,
    dirty: identity.dirtyFileCount > 0,
    dirtyFileCount: identity.dirtyFileCount,
  };
}

export async function cleanupDelegationWorkspace(context) {
  const expected = attribution(context);
  if (!expected) {
    return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
  }

  try {
    await git(expected.repoRoot, ["worktree", "remove", "--force", expected.path]);
    if (existsSync(expected.path)) {
      return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
    }
    activeWorktrees.delete(context.cleanupToken);
    return { cleaned: true, reason: null };
  } catch {
    return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
  }
}
