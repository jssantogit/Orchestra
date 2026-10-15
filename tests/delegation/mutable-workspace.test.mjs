import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import {
  cleanupMutableDelegationWorkspace,
  prepareMutableDelegationWorkspace,
} from "../../runtime/delegation/mutable-workspace.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-mutable-source-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

function dirtySource(repoRoot) {
  writeFileSync(join(repoRoot, "tracked.txt"), "staged\n");
  git(repoRoot, "add", "tracked.txt");
  writeFileSync(join(repoRoot, "tracked.txt"), "staged plus unstaged\n");
  writeFileSync(join(repoRoot, "untracked.txt"), "untracked candidate\n");
}

function requestFor(repoRoot) {
  const identity = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: "mutable-clone",
    taskId: "mutable-task",
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "mutable-task",
      candidateGeneration: 4,
      goal: "implement in an isolated clone",
      direction: { change: "edit authorized product files", preserve: ["canonical git state"] },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt", "untracked.txt"], forbidden: [".git/**", ".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: ["WORKSPACE_EDIT", "LOCAL_TEST"] },
      validation: ["isolated implementation"],
      failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
    },
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: identity.fingerprint,
      sourceRevision: identity.head,
      isolation: "EPHEMERAL_CLONE",
      mutationScope: { allowedPaths: ["tracked.txt", "untracked.txt"], forbiddenPaths: [] },
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

test("mutable delegation uses an independent hardened clone and exact dirty source snapshot", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-mutable-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  dirtySource(repoRoot);
  const sourceStatus = git(repoRoot, "status", "--porcelain=v1");
  const request = requestFor(repoRoot);

  const context = await prepareMutableDelegationWorkspace({ repoRoot, request, baseDir });
  t.after(async () => { await cleanupMutableDelegationWorkspace(context); });

  assert.equal(inside(repoRoot, context.path), false);
  assert.equal(existsSync(join(context.path, ".git")), true);
  assert.equal(git(context.path, "remote"), "");
  assert.equal(existsSync(join(context.path, ".git", "objects", "info", "alternates")), false);
  assert.equal(git(context.path, "rev-parse", "HEAD^"), request.workspace.sourceRevision);
  assert.equal(git(context.path, "rev-parse", "HEAD"), context.syntheticBaselineSha);
  assert.equal(git(context.path, "status", "--porcelain=v1"), "");
  assert.equal(readFileSync(join(context.path, "tracked.txt"), "utf8"), "staged plus unstaged\n");
  assert.equal(readFileSync(join(context.path, "untracked.txt"), "utf8"), "untracked candidate\n");

  const blob = git(repoRoot, "rev-parse", `${request.workspace.sourceRevision}:tracked.txt`);
  const sourceObject = join(repoRoot, ".git", "objects", blob.slice(0, 2), blob.slice(2));
  const cloneObject = join(context.path, ".git", "objects", blob.slice(0, 2), blob.slice(2));
  if (existsSync(sourceObject) && existsSync(cloneObject)) {
    assert.notEqual(statSync(sourceObject).ino, statSync(cloneObject).ino);
  }

  assert.equal(context.workerGitEnv.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(context.workerGitEnv.GIT_TERMINAL_PROMPT, "0");
  assert.equal(typeof context.workerGitEnv.GIT_CONFIG_GLOBAL, "string");
  assert.equal(context.workerGitEnv.GIT_CONFIG_COUNT >= 7, true);

  const remoteAttempt = spawnSync("git", ["ls-remote", repoRoot], {
    cwd: context.path,
    encoding: "utf8",
    env: { ...process.env, ...context.workerGitEnv },
  });
  assert.notEqual(remoteAttempt.status, 0);
  assert.match(`${remoteAttempt.stdout}${remoteAttempt.stderr}`, /not allowed|disabled|protocol/i);

  assert.equal(git(repoRoot, "status", "--porcelain=v1"), sourceStatus);
});

test("mutable cleanup is attribution-bound and removes only the delegated clone", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-mutable-cleanup-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const request = requestFor(repoRoot);
  const context = await prepareMutableDelegationWorkspace({ repoRoot, request, baseDir });
  const sibling = join(baseDir, "do-not-delete.txt");
  writeFileSync(sibling, "preserve\n");

  assert.deepEqual(await cleanupMutableDelegationWorkspace(context), { cleaned: true, reason: null });
  assert.equal(existsSync(context.path), false);
  assert.equal(existsSync(sibling), true);
  assert.deepEqual(await cleanupMutableDelegationWorkspace(context), { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" });
});
