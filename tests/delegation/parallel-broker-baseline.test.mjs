import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDelegationGitBoundary } from "../../runtime/delegation/git-boundary.mjs";
import { readDelegationProductFingerprint } from "../../runtime/delegation/source-snapshot.mjs";
import {
  cleanupMutableDelegationWorkspace,
  prepareMutableDelegationWorkspace,
} from "../../runtime/delegation/mutable-workspace.mjs";
import { executeParallelImplementationGroup } from "../../runtime/delegation/parallel-broker.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-parallel-source-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  // Orchestra project state is local runtime/governance state and is ignored in managed projects.
  // Mirror that contract in this tiny standalone Git fixture so product status stays factual.
  writeFileSync(join(root, ".git", "info", "exclude"), ".orchestra/\n", { flag: "a" });
  return root;
}

function dirtySource(root) {
  writeFileSync(join(root, "tracked.txt"), "staged\n");
  git(root, "add", "tracked.txt");
  writeFileSync(join(root, "tracked.txt"), "staged plus unstaged\n");
  writeFileSync(join(root, "untracked.txt"), "untracked candidate\n");
}

function packet({ area, generation }) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "parallel-dirty-task",
    candidateGeneration: generation,
    goal: "verify the exact shared source snapshot",
    direction: { change: "make no product mutation", preserve: ["dirty source snapshot"] },
    anchors: [{ file: area }],
    scope: { allowedAreas: [area], forbidden: [] },
    permissions: {
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
      sideEffects: ["LOCAL_TEST"],
    },
    validation: ["snapshot identity"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function executor(provider, snapshots) {
  return {
    provider,
    discover: async () => ({ available: true, provider, capabilities: { implementation: true } }),
    execute: async ({ workspace }) => {
      snapshots.push({
        provider,
        path: workspace.path,
        sourceRevision: workspace.sourceRevision,
        sourceFingerprint: workspace.sourceFingerprint,
        syntheticBaselineSha: workspace.syntheticBaselineSha,
        baselineTree: git(workspace.path, "rev-parse", `${workspace.syntheticBaselineSha}^{tree}`),
        tracked: readFileSync(join(workspace.path, "tracked.txt"), "utf8"),
        untracked: readFileSync(join(workspace.path, "untracked.txt"), "utf8"),
      });
      return {
        ok: true,
        provider,
        report: { summary: "snapshot observed", findings: [], evidenceRefs: [] },
        execution: { exitCode: 0, durationMs: 1 },
      };
    },
  };
}

test("both parallel clones materialize the same staged/unstaged/untracked source snapshot", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-parallel-clones-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  dirtySource(repoRoot);
  const sourceStatus = git(repoRoot, "status", "--porcelain=v1");
  const identity = readDelegationProductFingerprint(repoRoot);
  const gitBoundary = await readDelegationGitBoundary(repoRoot);
  const generation = 3;
  const group = {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: "parallel-dirty-baseline",
    taskId: "parallel-dirty-task",
    generation,
    source: { provider: "codex", actorIdHash: "sha256:root" },
    sourceRevision: identity.head,
    sourceFingerprint: identity.fingerprint,
    canonicalGitFingerprint: gitBoundary.fingerprint,
    members: [
      {
        memberId: "local",
        targetProvider: "codex",
        packet: packet({ area: "tracked.txt", generation }),
        mutationScope: { allowedPaths: ["tracked.txt"], forbiddenPaths: [] },
      },
      {
        memberId: "external",
        targetProvider: "antigravity",
        packet: packet({ area: "untracked.txt", generation }),
        mutationScope: { allowedPaths: ["untracked.txt"], forbiddenPaths: [] },
      },
    ],
  };
  const snapshots = [];
  const contexts = [];
  const artifacts = [];

  const result = await executeParallelImplementationGroup({
    repoRoot,
    group,
    actor: { provider: "codex", actorIdHash: "sha256:root", actorKind: "ROOT", isRoot: true },
    executors: [executor("codex", snapshots), executor("antigravity", snapshots)],
  }, {
    readLease: () => ({
      exists: true,
      valid: true,
      lease: {
        schema: "orchestra.work-lease.v1",
        projectLineage: "workspace-test",
        workspaceId: "primary",
        taskId: group.taskId,
        generation,
        state: "CONTROL",
        actor: { provider: "codex", sessionIdHash: "sha256:root" },
        capabilities: ["CONTROL"],
        candidate: null,
      },
    }),
    workspace: {
      prepare: async ({ repoRoot: root, request }) => {
        const context = await prepareMutableDelegationWorkspace({ repoRoot: root, request, baseDir });
        contexts.push(context);
        return context;
      },
      inspect: async () => ({
        changedPaths: [],
        dirtyFileCount: 0,
        canonicalWorkspaceChanged: false,
        canonicalGitChanged: false,
        cloneGitChanged: false,
        stagedByWorker: false,
      }),
      cleanup: cleanupMutableDelegationWorkspace,
    },
    artifacts: {
      seal: async ({ parallelBinding }) => {
        const artifact = {
          artifactId: `artifact-${parallelBinding.memberId}`,
          changedPaths: [],
          patchSha256: `sha256:${parallelBinding.memberId}`,
          mutationDigest: `sha256:${parallelBinding.memberId}`,
          state: "READY_FOR_REVIEW",
        };
        artifacts.push(artifact);
        return artifact;
      },
      discardBound: async () => ({ discarded: true, cleanup: { cleaned: true, reason: null } }),
    },
  });

  t.after(async () => {
    for (const context of contexts) await cleanupMutableDelegationWorkspace(context);
  });

  assert.equal(result.status, "MEMBERS_READY");
  assert.equal(snapshots.length, 2);
  assert.notEqual(snapshots[0].path, snapshots[1].path);
  assert.equal(snapshots[0].sourceRevision, snapshots[1].sourceRevision);
  assert.equal(snapshots[0].sourceFingerprint, snapshots[1].sourceFingerprint);
  assert.equal(snapshots[0].baselineTree, snapshots[1].baselineTree);
  assert.equal(snapshots[0].tracked, "staged plus unstaged\n");
  assert.equal(snapshots[1].tracked, "staged plus unstaged\n");
  assert.equal(snapshots[0].untracked, "untracked candidate\n");
  assert.equal(snapshots[1].untracked, "untracked candidate\n");
  assert.equal(git(repoRoot, "status", "--porcelain=v1"), sourceStatus);
  assert.equal(artifacts.length, 2);
});
