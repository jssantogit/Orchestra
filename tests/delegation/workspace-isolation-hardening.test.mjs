import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import {
  cleanupDelegationWorkspace,
  prepareDelegationWorkspace,
} from "../../runtime/delegation/workspace.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-isolation-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

function implementationPacket() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "workspace-isolation-task",
    candidateGeneration: 1,
    goal: "inspect isolated candidate",
    direction: {
      change: "inspect only the bounded delegated snapshot",
      preserve: ["canonical checkout", "host filesystem"],
    },
    anchors: [{ file: "tracked.txt" }],
    scope: {
      allowedAreas: ["**/*"],
      forbidden: [".orchestra/state/**", ".git/**"],
    },
    permissions: {
      discovery: "DIRECTED",
      tests: "READ_ONLY",
      sideEffects: ["LOCAL_TEST"],
    },
    validation: ["delegated workspace remains isolated"],
    failurePolicy: {
      selfCaused: "REPAIR",
      unrelatedOrUncertain: "RETURN_TO_CONTROL",
    },
  };
}

function requestFor(repoRoot, delegationId) {
  const identity = readWorkspaceFingerprint(repoRoot, {
    excludedPaths: [".orchestra/state/**"],
  });
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId,
    taskId: "workspace-isolation-task",
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: implementationPacket(),
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
      mutation: "FORBIDDEN",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: identity.fingerprint,
      sourceRevision: identity.head,
      isolation: "EPHEMERAL_WORKTREE",
    },
    limits: {
      timeoutMs: 120000,
      maxOutputBytes: 65536,
      delegationDepth: 1,
    },
  };
}

test("dirty snapshot refuses an untracked symlink that escapes the source workspace", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  const externalDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-external-"));
  const externalFile = join(externalDir, "secret.txt");
  writeFileSync(externalFile, "outside\n");

  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  t.after(() => rmSync(externalDir, { recursive: true, force: true }));

  try {
    symlinkSync(externalFile, join(repoRoot, "outside-link"));
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      t.skip(`symlink creation unavailable on this Windows runner: ${error.code}`);
      return;
    }
    throw error;
  }

  const request = requestFor(repoRoot, "snapshot-symlink-egress");
  await assert.rejects(
    () => prepareDelegationWorkspace({ repoRoot, request, baseDir }),
    (error) => {
      assert.equal(error?.code, "WORKSPACE_PREP_FAILED");
      assert.equal(error?.reason, "WORKSPACE_SNAPSHOT_SYMLINK_EGRESS");
      return true;
    },
  );
  assert.equal(existsSync(join(repoRoot, "outside-link")), true);
});

test("two simultaneous delegations receive distinct external worktrees and clean independently", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  const sourceBefore = readWorkspaceFingerprint(repoRoot, {
    excludedPaths: [".orchestra/state/**"],
  });

  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  const [first, second] = await Promise.all([
    prepareDelegationWorkspace({ repoRoot, request: requestFor(repoRoot, "concurrent-a"), baseDir }),
    prepareDelegationWorkspace({ repoRoot, request: requestFor(repoRoot, "concurrent-b"), baseDir }),
  ]);

  assert.notEqual(first.path, second.path);
  assert.equal(existsSync(first.path), true);
  assert.equal(existsSync(second.path), true);
  assert.equal(resolve(first.repoRoot), resolve(repoRoot));
  assert.equal(resolve(second.repoRoot), resolve(repoRoot));

  const cleanup = await Promise.all([
    cleanupDelegationWorkspace(first),
    cleanupDelegationWorkspace(second),
  ]);
  assert.deepEqual(cleanup, [
    { cleaned: true, reason: null },
    { cleaned: true, reason: null },
  ]);
  assert.equal(existsSync(first.path), false);
  assert.equal(existsSync(second.path), false);

  const sourceAfter = readWorkspaceFingerprint(repoRoot, {
    excludedPaths: [".orchestra/state/**"],
  });
  assert.equal(sourceAfter.fingerprint, sourceBefore.fingerprint);
});
