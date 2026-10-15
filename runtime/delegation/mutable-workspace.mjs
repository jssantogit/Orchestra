import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { assertDelegationRequest } from "../../core/domain/delegation.mjs";
import {
  readDelegationGitBoundary,
  readDelegationGitStdout,
  runDelegationGit,
} from "./git-boundary.mjs";
import {
  materializeDelegationSourceSnapshot,
  readDelegationProductFingerprint,
  readDelegationSourceIdentity,
  workspacePrepFailure,
} from "./source-snapshot.mjs";

const activeMutableWorkspaces = new Map();
const SYNTHETIC_AUTHOR_NAME = "Orchestra Delegation";
const SYNTHETIC_AUTHOR_EMAIL = "orchestra-delegation@localhost";

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function nulPaths(value) {
  return String(value ?? "").split("\0").filter(Boolean);
}

function isolatedBrokerGitEnv(globalConfigPath) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function buildWorkerGitEnv(globalConfigPath, hooksPath) {
  const entries = [
    ["core.hooksPath", hooksPath],
    ["protocol.allow", "never"],
    ["protocol.file.allow", "never"],
    ["protocol.http.allow", "never"],
    ["protocol.https.allow", "never"],
    ["protocol.ssh.allow", "never"],
    ["protocol.git.allow", "never"],
    ["protocol.ext.allow", "never"],
  ];
  const env = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return Object.freeze(env);
}

async function allocateWorkspace(baseDir) {
  const base = resolve(baseDir ?? tmpdir());
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "orchestra-implementation-"));
  const path = join(root, "workspace");
  const globalConfigPath = join(root, "git-global-config");
  const hooksPath = join(root, "empty-hooks");
  const templatePath = join(root, "empty-template");
  await writeFile(globalConfigPath, "", { encoding: "utf8", mode: 0o600 });
  await mkdir(hooksPath, { recursive: true });
  await mkdir(templatePath, { recursive: true });
  return { root, path, globalConfigPath, hooksPath, templatePath };
}

async function createIndependentClone(repoRoot, allocated) {
  const env = isolatedBrokerGitEnv(allocated.globalConfigPath);
  await runDelegationGit(repoRoot, [
    "clone",
    "--no-hardlinks",
    "--no-checkout",
    `--template=${allocated.templatePath}`,
    "--",
    repoRoot,
    allocated.path,
  ], { env, timeoutMs: 60_000 });

  await runDelegationGit(allocated.path, ["remote", "remove", "origin"], { env });
  await runDelegationGit(allocated.path, ["checkout", "--detach", "HEAD"], { env });

  const remoteNames = (await readDelegationGitStdout(allocated.path, ["remote"], { env })).trim();
  if (remoteNames) throw workspacePrepFailure("MUTABLE_CLONE_REMOTE_PRESENT");
  if (existsSync(join(allocated.path, ".git", "objects", "info", "alternates"))) {
    throw workspacePrepFailure("MUTABLE_CLONE_ALTERNATES_PRESENT");
  }
  return env;
}

async function checkoutSourceRevision(workspacePath, sourceRevision, env) {
  await runDelegationGit(workspacePath, ["checkout", "--detach", sourceRevision], { env });
  const head = (await readDelegationGitStdout(workspacePath, ["rev-parse", "HEAD"], { env })).trim();
  if (head !== sourceRevision) throw workspacePrepFailure("WORKSPACE_IDENTITY_MISMATCH");
}

async function createSyntheticBaseline(workspacePath, env) {
  await runDelegationGit(workspacePath, ["add", "-A", "--", "."], { env });
  await runDelegationGit(workspacePath, [
    "-c", `user.name=${SYNTHETIC_AUTHOR_NAME}`,
    "-c", `user.email=${SYNTHETIC_AUTHOR_EMAIL}`,
    "-c", "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-m", "Orchestra delegated source baseline",
  ], { env });
  return (await readDelegationGitStdout(workspacePath, ["rev-parse", "HEAD"], { env })).trim();
}

function attribution(context) {
  if (!context || typeof context.cleanupToken !== "string") return null;
  const expected = activeMutableWorkspaces.get(context.cleanupToken);
  if (!expected) return null;
  if (resolve(context.repoRoot ?? "") !== expected.repoRoot) return null;
  if (resolve(context.path ?? "") !== expected.path) return null;
  return expected;
}

async function changedPathsSinceBaseline(workspacePath, baselineSha) {
  const [tracked, untracked] = await Promise.all([
    readDelegationGitStdout(workspacePath, ["diff", "--name-only", "-z", baselineSha, "--"]),
    readDelegationGitStdout(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...nulPaths(tracked), ...nulPaths(untracked)])].sort();
}

export async function prepareMutableDelegationWorkspace({ repoRoot, request, baseDir = null } = {}) {
  assertDelegationRequest(request);
  if (request.schema !== "orchestra.delegation-request.v2") {
    throw workspacePrepFailure("MUTABLE_REQUEST_VERSION_INVALID");
  }
  if (!repoRoot) throw workspacePrepFailure("SOURCE_GIT_UNAVAILABLE");

  const root = resolve(repoRoot);
  const source = readDelegationSourceIdentity(root, {
    sourceRevision: request.workspace.sourceRevision,
    sourceFingerprint: request.workspace.sourceFingerprint,
  });
  const canonicalGit = await readDelegationGitBoundary(root);
  if (!canonicalGit.available) throw workspacePrepFailure("SOURCE_GIT_UNAVAILABLE");

  const allocated = await allocateWorkspace(baseDir);
  if (inside(root, allocated.root) || inside(root, allocated.path)) {
    await rm(allocated.root, { recursive: true, force: true });
    throw workspacePrepFailure("WORKSPACE_PATH_INVALID");
  }

  try {
    const brokerGitEnv = await createIndependentClone(root, allocated);
    await checkoutSourceRevision(allocated.path, request.workspace.sourceRevision, brokerGitEnv);
    await materializeDelegationSourceSnapshot({
      sourceRoot: root,
      targetRoot: allocated.path,
      source,
    });

    const materialized = readDelegationProductFingerprint(allocated.path);
    if (!materialized.available
        || materialized.head !== request.workspace.sourceRevision
        || materialized.fingerprint !== source.fingerprint) {
      throw workspacePrepFailure("WORKSPACE_IDENTITY_MISMATCH");
    }

    const syntheticBaselineSha = await createSyntheticBaseline(allocated.path, brokerGitEnv);
    await runDelegationGit(allocated.path, ["remote", "remove", "origin"], { env: brokerGitEnv }).catch(() => {});
    const remoteNames = (await readDelegationGitStdout(allocated.path, ["remote"], { env: brokerGitEnv })).trim();
    if (remoteNames) throw workspacePrepFailure("MUTABLE_CLONE_REMOTE_PRESENT");
    if (existsSync(join(allocated.path, ".git", "objects", "info", "alternates"))) {
      throw workspacePrepFailure("MUTABLE_CLONE_ALTERNATES_PRESENT");
    }

    const cleanStatus = (await readDelegationGitStdout(allocated.path, ["status", "--porcelain=v1"], { env: brokerGitEnv })).trim();
    if (cleanStatus) throw workspacePrepFailure("MUTABLE_BASELINE_DIRTY");

    const [cloneGit, canonicalGitAfter] = await Promise.all([
      readDelegationGitBoundary(allocated.path, { env: brokerGitEnv }),
      readDelegationGitBoundary(root),
    ]);
    if (!cloneGit.available || !canonicalGitAfter.available) throw workspacePrepFailure("SOURCE_GIT_UNAVAILABLE");
    if (canonicalGitAfter.fingerprint !== canonicalGit.fingerprint) {
      throw workspacePrepFailure("CANONICAL_GIT_CHANGED_DURING_PREP");
    }

    const cleanupToken = randomBytes(32).toString("hex");
    const record = Object.freeze({
      repoRoot: root,
      path: resolve(allocated.path),
      scratchRoot: resolve(allocated.root),
      sourceFingerprint: source.fingerprint,
      sourceRevision: request.workspace.sourceRevision,
      canonicalGitFingerprint: canonicalGit.fingerprint,
      cloneGitFingerprint: cloneGit.fingerprint,
      syntheticBaselineSha,
      workerGitEnv: buildWorkerGitEnv(allocated.globalConfigPath, allocated.hooksPath),
    });
    activeMutableWorkspaces.set(cleanupToken, record);

    return {
      repoRoot: record.repoRoot,
      path: record.path,
      sourceRevision: record.sourceRevision,
      sourceFingerprint: record.sourceFingerprint,
      syntheticBaselineSha: record.syntheticBaselineSha,
      canonicalGitFingerprint: record.canonicalGitFingerprint,
      cloneGitFingerprint: record.cloneGitFingerprint,
      workerGitEnv: record.workerGitEnv,
      cleanupToken,
    };
  } catch (error) {
    await rm(allocated.root, { recursive: true, force: true });
    if (error?.code === "WORKSPACE_PREP_FAILED") throw error;
    throw workspacePrepFailure("MUTABLE_CLONE_PREP_FAILED", error);
  }
}

export async function inspectMutableDelegationWorkspace(context) {
  const expected = attribution(context);
  if (!expected) throw workspacePrepFailure("WORKSPACE_CONTEXT_INVALID");

  const [changedPaths, staged, canonicalSource, canonicalGit, cloneGit] = await Promise.all([
    changedPathsSinceBaseline(expected.path, expected.syntheticBaselineSha),
    readDelegationGitStdout(expected.path, ["diff", "--cached", "--name-only", "-z", expected.syntheticBaselineSha, "--"]),
    Promise.resolve(readDelegationProductFingerprint(expected.repoRoot)),
    readDelegationGitBoundary(expected.repoRoot),
    readDelegationGitBoundary(expected.path),
  ]);

  if (!canonicalSource.available || !canonicalGit.available || !cloneGit.available) {
    throw workspacePrepFailure("WORKSPACE_INSPECTION_FAILED");
  }

  return {
    changedPaths,
    dirtyFileCount: changedPaths.length,
    canonicalWorkspaceChanged: canonicalSource.fingerprint !== expected.sourceFingerprint,
    canonicalGitChanged: canonicalGit.fingerprint !== expected.canonicalGitFingerprint,
    cloneGitChanged: cloneGit.fingerprint !== expected.cloneGitFingerprint,
    stagedByWorker: nulPaths(staged).length > 0,
  };
}

export async function cleanupMutableDelegationWorkspace(context) {
  const expected = attribution(context);
  if (!expected) return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
  try {
    await rm(expected.scratchRoot, { recursive: true, force: true });
    if (existsSync(expected.scratchRoot) || existsSync(expected.path)) {
      return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
    }
    activeMutableWorkspaces.delete(context.cleanupToken);
    return { cleaned: true, reason: null };
  } catch {
    return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
  }
}
