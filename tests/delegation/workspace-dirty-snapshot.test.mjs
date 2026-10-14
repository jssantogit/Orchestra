import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import {
  cleanupDelegationWorkspace,
  inspectDelegationWorkspace,
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
  const root = mkdtempSync(join(tmpdir(), "orchestra-dirty-source-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

function requestFor(repoRoot) {
  const identity = readWorkspaceFingerprint(repoRoot, {
    excludedPaths: [".orchestra/state/**"],
  });
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "dirty-candidate-review",
    taskId: "dirty-candidate-task",
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "dirty-candidate-task",
      candidateGeneration: 1,
      goal: "review the exact uncommitted candidate",
      direction: {
        change: "inspect the candidate snapshot",
        preserve: ["canonical checkout"],
      },
      anchors: [{ file: "tracked.txt" }, { file: "new-file.txt" }],
      scope: {
        allowedAreas: ["**/*"],
        forbidden: [".orchestra/state/**"],
      },
      permissions: {
        discovery: "DIRECTED",
        tests: "READ_ONLY",
        sideEffects: ["LOCAL_TEST"],
      },
      validation: ["delegated snapshot matches the candidate"],
      failurePolicy: {
        selfCaused: "REPAIR",
        unrelatedOrUncertain: "RETURN_TO_CONTROL",
      },
    },
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

test("dirty tracked and untracked candidate is materialized exactly and only worker changes count as delegation dirtiness", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-dirty-delegation-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  writeFileSync(join(repoRoot, "tracked.txt"), "candidate\n");
  writeFileSync(join(repoRoot, "new-file.txt"), "new candidate file\n");
  const sourceStatusBefore = git(repoRoot, "status", "--porcelain=v1");
  const request = requestFor(repoRoot);

  const context = await prepareDelegationWorkspace({ repoRoot, request, baseDir });
  t.after(async () => { await cleanupDelegationWorkspace(context); });

  assert.equal(context.initialFingerprint, request.workspace.sourceFingerprint);
  assert.equal(readFileSync(join(context.path, "tracked.txt"), "utf8"), "candidate\n");
  assert.equal(readFileSync(join(context.path, "new-file.txt"), "utf8"), "new candidate file\n");

  const unchanged = await inspectDelegationWorkspace(context);
  assert.equal(unchanged.finalFingerprint, context.initialFingerprint);
  assert.equal(unchanged.dirty, false);
  assert.equal(unchanged.dirtyFileCount, 0);

  writeFileSync(join(context.path, "worker-output.txt"), "worker mutation\n");
  const changed = await inspectDelegationWorkspace(context);
  assert.equal(changed.dirty, true);
  assert.equal(changed.dirtyFileCount > 0, true);
  assert.notEqual(changed.finalFingerprint, context.initialFingerprint);

  assert.equal(git(repoRoot, "status", "--porcelain=v1"), sourceStatusBefore);
  assert.equal(readFileSync(join(repoRoot, "tracked.txt"), "utf8"), "candidate\n");
  assert.equal(existsSync(join(repoRoot, "new-file.txt")), true);
});
