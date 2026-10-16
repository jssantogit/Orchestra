import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { devNull, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import {
  buildDelegationGitEnvironment,
  readDelegationGitBoundary,
} from "../../runtime/delegation/git-boundary.mjs";
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
  const root = mkdtempSync(join(tmpdir(), "orchestra-git-hook-mutation-source-"));
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
    delegationId: "git-hook-mutation-boundary",
    taskId: "git-hook-mutation-boundary-task",
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "git-hook-mutation-boundary-task",
      candidateGeneration: 1,
      goal: "inspect only without mutating canonical Git hooks",
      direction: { change: "inspect only", preserve: ["canonical git hooks"] },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt"], forbidden: [".git/**", ".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: ["LOCAL_TEST"] },
      validation: ["canonical Git hooks remain unchanged"],
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

test("canonical hook mutation through shared Git metadata is reported as delegation dirtiness", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-git-hook-mutation-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  const context = await prepareDelegationWorkspace({
    repoRoot,
    request: requestFor(repoRoot),
    baseDir,
  });
  t.after(async () => { await cleanupDelegationWorkspace(context); });

  const beforeBoundary = await readDelegationGitBoundary(repoRoot);
  const sourceCommonDirText = git(repoRoot, "rev-parse", "--git-common-dir");
  const commonDirText = git(context.path, "rev-parse", "--git-common-dir");
  const commonDir = isAbsolute(commonDirText)
    ? commonDirText
    : resolve(context.path, commonDirText);
  const hooksDir = join(commonDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");

  const afterBoundary = await readDelegationGitBoundary(repoRoot);
  const env = buildDelegationGitEnvironment();
  console.error("ORCHESTRA_GIT_HOOK_DIAGNOSTIC", JSON.stringify({
    platform: process.platform,
    devNull,
    gitConfigGlobal: env.GIT_CONFIG_GLOBAL,
    repoRoot,
    contextPath: context.path,
    sourceCommonDirText,
    worktreeCommonDirText: commonDirText,
    resolvedCommonDir: commonDir,
    hookEntries: readdirSync(hooksDir).sort(),
    beforeBoundary,
    afterBoundary,
    boundaryChanged: beforeBoundary.fingerprint !== afterBoundary.fingerprint,
  }));

  const inspection = await inspectDelegationWorkspace(context);
  console.error("ORCHESTRA_GIT_HOOK_INSPECTION", JSON.stringify(inspection));
  assert.equal(inspection.dirty, true);
  assert.equal(inspection.canonicalGitChanged, true);
});
