import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import {
  cleanupMutableDelegationWorkspace,
  inspectMutableDelegationWorkspace,
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
  const root = mkdtempSync(join(tmpdir(), "orchestra-mutable-boundary-source-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

function requestFor(repoRoot, id) {
  const identity = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: id,
    taskId: `${id}-task`,
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: `${id}-task`,
      candidateGeneration: 2,
      goal: "mutate only the delegated product workspace",
      direction: { change: "edit tracked.txt", preserve: ["git metadata"] },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt"], forbidden: [".git/**", ".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: ["WORKSPACE_EDIT"] },
      validation: ["git boundary remains sealed"],
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
      mutationScope: { allowedPaths: ["tracked.txt"], forbiddenPaths: [] },
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

test("product edits are allowed facts while worker staging is separately detected", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-mutable-boundary-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const context = await prepareMutableDelegationWorkspace({
    repoRoot,
    request: requestFor(repoRoot, "mutable-product-edit"),
    baseDir,
  });
  t.after(async () => { await cleanupMutableDelegationWorkspace(context); });

  writeFileSync(join(context.path, "tracked.txt"), "worker edit\n");
  const edited = await inspectMutableDelegationWorkspace(context);
  assert.deepEqual(edited.changedPaths, ["tracked.txt"]);
  assert.equal(edited.dirtyFileCount, 1);
  assert.equal(edited.canonicalWorkspaceChanged, false);
  assert.equal(edited.canonicalGitChanged, false);
  assert.equal(edited.cloneGitChanged, false);
  assert.equal(edited.stagedByWorker, false);

  git(context.path, "add", "tracked.txt");
  const staged = await inspectMutableDelegationWorkspace(context);
  assert.equal(staged.stagedByWorker, true);
  assert.deepEqual(staged.changedPaths, ["tracked.txt"]);
});

test("clone refs, HEAD, config, and canonical Git boundaries are independent and detectable", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-mutable-git-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const context = await prepareMutableDelegationWorkspace({
    repoRoot,
    request: requestFor(repoRoot, "mutable-git-edit"),
    baseDir,
  });
  t.after(async () => { await cleanupMutableDelegationWorkspace(context); });

  git(context.path, "tag", "worker-only-tag", "HEAD");
  let inspection = await inspectMutableDelegationWorkspace(context);
  assert.equal(inspection.cloneGitChanged, true);
  assert.equal(inspection.canonicalGitChanged, false);
  assert.throws(() => git(repoRoot, "show-ref", "--verify", "refs/tags/worker-only-tag"));

  git(context.path, "tag", "-d", "worker-only-tag");
  git(context.path, "config", "user.name", "Worker Override");
  inspection = await inspectMutableDelegationWorkspace(context);
  assert.equal(inspection.cloneGitChanged, true);
  assert.equal(inspection.canonicalGitChanged, false);

  git(context.path, "config", "user.email", "worker@example.com");
  writeFileSync(join(context.path, "tracked.txt"), "committed worker edit\n");
  git(context.path, "add", "tracked.txt");
  git(context.path, "commit", "-m", "worker attempted commit");
  inspection = await inspectMutableDelegationWorkspace(context);
  assert.equal(inspection.cloneGitChanged, true);
  assert.equal(inspection.canonicalGitChanged, false);
  assert.notEqual(git(context.path, "rev-parse", "HEAD"), context.syntheticBaselineSha);
});
