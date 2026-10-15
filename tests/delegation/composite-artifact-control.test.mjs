import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { claimWorkLease } from "../../core/leases/work-lease-store.mjs";
import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { sealDelegationArtifact } from "../../runtime/delegation/artifact-lifecycle.mjs";
import {
  composeParallelArtifacts,
  discardCompositeArtifact,
  inspectCompositeArtifact,
  promoteCompositeArtifact,
} from "../../runtime/delegation/composite-artifact-lifecycle.mjs";
import { readCompositeArtifact } from "../../runtime/delegation/composite-artifact-store.mjs";
import { readDelegationGitBoundary } from "../../runtime/delegation/git-boundary.mjs";
import {
  cleanupMutableDelegationWorkspace,
  prepareMutableDelegationWorkspace,
} from "../../runtime/delegation/mutable-workspace.mjs";
import {
  createParallelGroup,
  readParallelGroup,
  transitionParallelGroupState,
} from "../../runtime/delegation/parallel-group-store.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function createRepo({ dirtyBaseline = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-composite-control-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "home.txt"), "home-before\n");
  writeFileSync(join(root, "library.txt"), "library-before\n");
  writeFileSync(join(root, "staged.txt"), "staged-before\n");
  writeFileSync(join(root, "unstaged.txt"), "unstaged-before\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  if (dirtyBaseline) {
    writeFileSync(join(root, "staged.txt"), "staged-canonical\n");
    git(root, "add", "staged.txt");
    writeFileSync(join(root, "unstaged.txt"), "unstaged-canonical\n");
    writeFileSync(join(root, "preexisting-untracked.txt"), "untracked-canonical\n");
  }
  return root;
}

function packet(taskId, generation, file) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId,
    candidateGeneration: generation,
    goal: `edit ${file}`,
    direction: { change: `change ${file}`, preserve: ["other shard"] },
    anchors: [{ file }],
    scope: { allowedAreas: [file], forbidden: [] },
    permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: [] },
    validation: ["focused tests"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function request(group, member, artifactId) {
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: artifactId,
    taskId: group.taskId,
    source: { ...group.source },
    target: { provider: member.targetProvider, logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: member.packet,
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: group.sourceFingerprint,
      sourceRevision: group.sourceRevision,
      isolation: "EPHEMERAL_CLONE",
      mutationScope: member.mutationScope,
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

function actor(overrides = {}) {
  return {
    provider: "codex",
    actorIdHash: "sha256:root",
    actorKind: "ROOT",
    isRoot: true,
    ...overrides,
  };
}

async function readyComposite(t, { dirtyBaseline = false } = {}) {
  const repoRoot = createRepo({ dirtyBaseline });
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const taskId = "composite-control-task";
  const claimed = claimWorkLease(repoRoot, {
    taskId,
    actor: { provider: "codex", sessionIdHash: "sha256:root" },
    capabilities: ["CONTROL"],
    expectedGeneration: -1,
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.lease.generation, 0);

  const source = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  const gitBoundary = await readDelegationGitBoundary(repoRoot);
  const group = {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: `group-control-${Math.random().toString(16).slice(2)}`,
    taskId,
    generation: 0,
    source: { provider: "codex", actorIdHash: "sha256:root" },
    sourceRevision: source.head,
    sourceFingerprint: source.fingerprint,
    canonicalGitFingerprint: gitBoundary.fingerprint,
    members: [
      {
        memberId: "a",
        targetProvider: "codex",
        packet: packet(taskId, 0, "home.txt"),
        mutationScope: { allowedPaths: ["home.txt"], forbiddenPaths: [] },
      },
      {
        memberId: "b",
        targetProvider: "antigravity",
        packet: packet(taskId, 0, "library.txt"),
        mutationScope: { allowedPaths: ["library.txt"], forbiddenPaths: [] },
      },
    ],
  };
  createParallelGroup(repoRoot, group);
  assert.equal(transitionParallelGroupState(repoRoot, group.groupId, {
    expectedState: "CREATED",
    nextState: "RUNNING",
  }).transitioned, true);

  const artifactIds = [];
  for (const member of group.members) {
    const artifactId = `member-${member.memberId}-${Math.random().toString(16).slice(2)}`;
    const req = request(group, member, artifactId);
    const baseDir = mkdtempSync(join(tmpdir(), `orchestra-composite-member-${member.memberId}-`));
    t.after(() => rmSync(baseDir, { recursive: true, force: true }));
    const workspace = await prepareMutableDelegationWorkspace({ repoRoot, request: req, baseDir });
    t.after(async () => { await cleanupMutableDelegationWorkspace(workspace); });
    writeFileSync(
      join(workspace.path, member.memberId === "a" ? "home.txt" : "library.txt"),
      `${member.memberId}-after\n`,
    );
    const sealed = await sealDelegationArtifact({
      repoRoot,
      request: req,
      generation: 0,
      actor: actor(),
      workspace,
      report: { summary: "done", findings: [], evidenceRefs: [] },
      parallelBinding: { groupId: group.groupId, memberId: member.memberId },
    });
    artifactIds.push(sealed.artifactId);
  }
  assert.equal(transitionParallelGroupState(repoRoot, group.groupId, {
    expectedState: "RUNNING",
    nextState: "MEMBERS_READY",
    memberArtifactIds: artifactIds,
  }).transitioned, true);

  const composed = await composeParallelArtifacts({ repoRoot, group, memberArtifactIds: artifactIds });
  assert.equal(composed.composed, true);
  assert.equal(readParallelGroup(repoRoot, group.groupId).record.state, "READY_FOR_REVIEW");
  return { repoRoot, group, composed };
}

test("inspect validates a READY composite without mutating canonical product", async (t) => {
  const fixture = await readyComposite(t);
  const before = readWorkspaceFingerprint(fixture.repoRoot, { excludedPaths: [".orchestra/state/**"] });
  const inspected = await inspectCompositeArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.composed.artifactId,
  });
  assert.equal(inspected.integrity.valid, true);
  assert.equal(inspected.manifest.state, "READY_FOR_REVIEW");
  assert.equal(inspected.reviewPath, fixture.composed.reviewPath);
  const after = readWorkspaceFingerprint(fixture.repoRoot, { excludedPaths: [".orchestra/state/**"] });
  assert.equal(after.fingerprint, before.fingerprint);
});

test("promotion denies wrong CONTROL identity or generation before canonical mutation", async (t) => {
  const cases = [
    { generation: 0, actor: actor({ provider: "antigravity" }) },
    { generation: 0, actor: actor({ actorIdHash: "sha256:other" }) },
    { generation: 1, actor: actor() },
  ];
  for (const entry of cases) {
    await t.test(`${entry.actor.provider}-${entry.generation}-${entry.actor.actorIdHash}`, async (subtest) => {
      const fixture = await readyComposite(subtest);
      const result = await promoteCompositeArtifact({
        repoRoot: fixture.repoRoot,
        artifactId: fixture.composed.artifactId,
        generation: entry.generation,
        actor: entry.actor,
      });
      assert.equal(result.promoted, false);
      assert.equal(result.reason, "CAPABILITY_DENIED");
      assert.equal(readFileSync(join(fixture.repoRoot, "home.txt"), "utf8"), "home-before\n");
      assert.equal(readFileSync(join(fixture.repoRoot, "library.txt"), "utf8"), "library-before\n");
    });
  }
});

test("promotion applies one composite delta while preserving pre-existing staged unstaged and untracked state", async (t) => {
  const fixture = await readyComposite(t, { dirtyBaseline: true });
  const indexBefore = git(fixture.repoRoot, "diff", "--cached", "--binary", "--full-index", "HEAD", "--");
  const result = await promoteCompositeArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.composed.artifactId,
    generation: 0,
    actor: actor(),
  });
  assert.equal(result.promoted, true);
  assert.equal(result.reason, null);
  assert.deepEqual(result.changedPaths, ["home.txt", "library.txt"]);
  assert.equal(readFileSync(join(fixture.repoRoot, "home.txt"), "utf8"), "a-after\n");
  assert.equal(readFileSync(join(fixture.repoRoot, "library.txt"), "utf8"), "b-after\n");
  assert.equal(readFileSync(join(fixture.repoRoot, "unstaged.txt"), "utf8"), "unstaged-canonical\n");
  assert.equal(readFileSync(join(fixture.repoRoot, "preexisting-untracked.txt"), "utf8"), "untracked-canonical\n");
  assert.equal(git(fixture.repoRoot, "diff", "--cached", "--binary", "--full-index", "HEAD", "--"), indexBefore);
  assert.equal(readCompositeArtifact(fixture.repoRoot, fixture.composed.artifactId).manifest.state, "PROMOTED");
  assert.equal(readParallelGroup(fixture.repoRoot, fixture.group.groupId).record.state, "PROMOTED");
  assert.equal(existsSync(dirname(fixture.composed.reviewPath)), false);
});

test("canonical drift makes composite promotion stale without applying the patch", async (t) => {
  const fixture = await readyComposite(t);
  writeFileSync(join(fixture.repoRoot, "home.txt"), "canonical-drift\n");
  const result = await promoteCompositeArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.composed.artifactId,
    generation: 0,
    actor: actor(),
  });
  assert.deepEqual(result, { promoted: false, reason: "PROMOTION_STALE", changedPaths: [] });
  assert.equal(readFileSync(join(fixture.repoRoot, "home.txt"), "utf8"), "canonical-drift\n");
  assert.equal(readFileSync(join(fixture.repoRoot, "library.txt"), "utf8"), "library-before\n");
});

test("discard closes composite and group without canonical product mutation", async (t) => {
  const fixture = await readyComposite(t);
  const result = await discardCompositeArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.composed.artifactId,
    generation: 0,
    actor: actor(),
  });
  assert.equal(result.discarded, true);
  assert.equal(result.reason, null);
  assert.equal(readFileSync(join(fixture.repoRoot, "home.txt"), "utf8"), "home-before\n");
  assert.equal(readFileSync(join(fixture.repoRoot, "library.txt"), "utf8"), "library-before\n");
  assert.equal(readCompositeArtifact(fixture.repoRoot, fixture.composed.artifactId).manifest.state, "DISCARDED");
  assert.equal(readParallelGroup(fixture.repoRoot, fixture.group.groupId).record.state, "DISCARDED");
  assert.equal(existsSync(dirname(fixture.composed.reviewPath)), false);
});
