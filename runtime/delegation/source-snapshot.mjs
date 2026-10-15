import { cp, lstat, mkdir, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { readDelegationGitStdout, runDelegationGit } from "./git-boundary.mjs";

export const PRODUCT_FINGERPRINT_EXCLUDES = Object.freeze([".orchestra/state/**"]);

export function workspacePrepFailure(detail, cause = undefined) {
  const error = new Error(`WORKSPACE_PREP_FAILED:${detail}`);
  error.code = "WORKSPACE_PREP_FAILED";
  error.detail = detail;
  error.reason = detail;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function productPathspecs() {
  return [
    ".",
    ...PRODUCT_FINGERPRINT_EXCLUDES.map((path) => `:(exclude)${path}`),
  ];
}

function nulPaths(value) {
  return String(value ?? "").split("\0").filter(Boolean);
}

export function readDelegationProductFingerprint(repoRoot) {
  return readWorkspaceFingerprint(repoRoot, {
    excludedPaths: PRODUCT_FINGERPRINT_EXCLUDES,
  });
}

export function readDelegationSourceIdentity(repoRoot, { sourceRevision, sourceFingerprint } = {}) {
  const root = resolve(repoRoot);
  const identity = readDelegationProductFingerprint(root);
  if (!identity.available) throw workspacePrepFailure("SOURCE_GIT_UNAVAILABLE");
  if (identity.head !== sourceRevision) {
    throw workspacePrepFailure("SOURCE_REVISION_MISMATCH");
  }
  if (identity.fingerprint !== sourceFingerprint) {
    if (identity.dirtyFileCount !== 0) throw workspacePrepFailure("SOURCE_WORKSPACE_DIRTY");
    throw workspacePrepFailure("SOURCE_FINGERPRINT_MISMATCH");
  }
  return identity;
}

export async function assertDelegationSnapshotSymlinkSafety(sourceRoot) {
  const paths = nulPaths(await readDelegationGitStdout(sourceRoot, [
    "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...productPathspecs(),
  ]));

  for (const relPath of paths) {
    const absolute = resolve(sourceRoot, relPath);
    if (!inside(sourceRoot, absolute)) {
      throw workspacePrepFailure("WORKSPACE_SNAPSHOT_PATH_INVALID");
    }

    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw workspacePrepFailure("WORKSPACE_SNAPSHOT_PATH_INVALID", error);
    }
    if (!stat.isSymbolicLink()) continue;

    let rawTarget;
    try {
      rawTarget = await readlink(absolute);
    } catch (error) {
      throw workspacePrepFailure("WORKSPACE_SNAPSHOT_SYMLINK_EGRESS", error);
    }

    const lexicalTarget = isAbsolute(rawTarget)
      ? resolve(rawTarget)
      : resolve(dirname(absolute), rawTarget);
    if (!inside(sourceRoot, lexicalTarget)) {
      throw workspacePrepFailure("WORKSPACE_SNAPSHOT_SYMLINK_EGRESS");
    }

    try {
      const resolvedTarget = await realpath(lexicalTarget);
      if (!inside(sourceRoot, resolvedTarget)) {
        throw workspacePrepFailure("WORKSPACE_SNAPSHOT_SYMLINK_EGRESS");
      }
    } catch (error) {
      if (error?.code === "WORKSPACE_PREP_FAILED") throw error;
      if (error?.code !== "ENOENT") {
        throw workspacePrepFailure("WORKSPACE_SNAPSHOT_SYMLINK_EGRESS", error);
      }
    }
  }
}

async function copyUntrackedPath(sourceRoot, targetRoot, relPath) {
  const source = resolve(sourceRoot, relPath);
  const target = resolve(targetRoot, relPath);
  if (!inside(sourceRoot, source) || !inside(targetRoot, target)) {
    throw workspacePrepFailure("WORKSPACE_SNAPSHOT_PATH_INVALID");
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

export async function materializeDelegationSourceSnapshot({ sourceRoot, targetRoot, source } = {}) {
  if (!source || source.dirtyFileCount === 0) return;
  await assertDelegationSnapshotSymlinkSafety(sourceRoot);

  const scratch = await mkdtemp(join(tmpdir(), "orchestra-delegation-snapshot-"));
  const cachedPatchPath = join(scratch, "cached.patch");
  const unstagedPatchPath = join(scratch, "unstaged.patch");
  const specs = productPathspecs();

  try {
    const cachedPatch = await readDelegationGitStdout(sourceRoot, [
      "diff", "--cached", "--binary", "HEAD", "--", ...specs,
    ]);
    const unstagedPatch = await readDelegationGitStdout(sourceRoot, [
      "diff", "--binary", "--", ...specs,
    ]);
    const untracked = nulPaths(await readDelegationGitStdout(sourceRoot, [
      "ls-files", "--others", "--exclude-standard", "-z", "--", ...specs,
    ]));

    if (cachedPatch.length > 0) {
      await writeFile(cachedPatchPath, cachedPatch, "utf8");
      await runDelegationGit(targetRoot, ["apply", "--index", "--binary", cachedPatchPath]);
    }
    if (unstagedPatch.length > 0) {
      await writeFile(unstagedPatchPath, unstagedPatch, "utf8");
      await runDelegationGit(targetRoot, ["apply", "--binary", unstagedPatchPath]);
    }
    for (const relPath of untracked) {
      await copyUntrackedPath(sourceRoot, targetRoot, relPath);
    }

    const sourceAfter = readDelegationProductFingerprint(sourceRoot);
    if (!sourceAfter.available || sourceAfter.fingerprint !== source.fingerprint) {
      throw workspacePrepFailure("SOURCE_CHANGED_DURING_SNAPSHOT");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
