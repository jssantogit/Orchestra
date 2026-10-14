import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  const root = mkdtempSync(join(tmpdir(), "orchestra-git-boundary-source-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

function requestFor(repoRoot, id = "git-hook-boundary") {
  const identity = readWorkspaceFingerprint(repoRoot, {
    excludedPaths: [".orchestra/state/**"],
  });
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: id,
    taskId: `${id}-task`,
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: `${id}-task`,
      candidateGeneration: 1,
      goal: "prepare a delegated workspace without mutating canonical Git state",
      direction: { change: "inspect only", preserve: ["canonical git metadata"] },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt"], forbidden: [".git/**", ".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: ["LOCAL_TEST"] },
      validation: ["canonical Git state remains unchanged"],
      failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
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
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

test("workspace preparation never executes hooks from the canonical repository", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-git-boundary-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  const gitDir = join(repoRoot, ".git");
  const hooksDir = join(gitDir, "hooks");
  const sentinel = join(gitDir, "orchestra-delegation-hook-fired");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "post-checkout");
  writeFileSync(hookPath, [
    "#!/bin/sh",
    "git_common_dir=$(git rev-parse --git-common-dir)",
    "printf 'fired\\n' > \"$git_common_dir/orchestra-delegation-hook-fired\"",
    "",
  ].join("\n"));
  chmodSync(hookPath, 0o755);

  const context = await prepareDelegationWorkspace({
    repoRoot,
    request: requestFor(repoRoot),
    baseDir,
  });
  t.after(async () => { await cleanupDelegationWorkspace(context); });

  assert.equal(existsSync(sentinel), false);
});

test("canonical refs mutated through delegated worktree are reported as delegation dirtiness", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-git-boundary-ref-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  const context = await prepareDelegationWorkspace({
    repoRoot,
    request: requestFor(repoRoot, "git-ref-boundary"),
    baseDir,
  });
  t.after(async () => { await cleanupDelegationWorkspace(context); });

  git(context.path, "tag", "orchestra-delegation-injected-tag", "HEAD");
  assert.equal(git(repoRoot, "show-ref", "--verify", "--quiet", "refs/tags/orchestra-delegation-injected-tag"), "");

  const inspection = await inspectDelegationWorkspace(context);
  assert.equal(inspection.dirty, true);
  assert.equal(inspection.canonicalGitChanged, true);
});
