import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { sealDelegationArtifact } from "../../runtime/delegation/artifact-lifecycle.mjs";
import { readCompositeArtifact } from "../../runtime/delegation/composite-artifact-store.mjs";
import { composeParallelMemberArtifacts } from "../../runtime/delegation/composite-artifact-lifecycle.mjs";
import { readDelegationGitBoundary } from "../../runtime/delegation/git-boundary.mjs";
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
  const root = mkdtempSync(join(tmpdir(), "orchestra-parallel-compose-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "home.txt"), "home-before\n");
  writeFileSync(join(root, "library.txt"), "library-before\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
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

function request(group, member, delegationId) {
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId,
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

async function groupFor(repoRoot) {
  const source = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  const gitBoundary = await readDelegationGitBoundary(repoRoot);
  const taskId = "task-compose-real";
  const generation = 7;
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: "group-compose-real",
    taskId,
    generation,
    source: { provider: "codex", actorIdHash: "sha256:root" },
    sourceRevision: source.head,
    sourceFingerprint: source.fingerprint,
    canonicalGitFingerprint: gitBoundary.fingerprint,
    members: [
      {
        memberId: "a",
        targetProvider: "codex",
        packet: packet(taskId, generation, "home.txt"),
        mutationScope: { allowedPaths: ["home.txt"], forbiddenPaths: [] },
      },
      {
        memberId: "b",
        targetProvider: "antigravity",
        packet: packet(taskId, generation, "library.txt"),
        mutationScope: { allowedPaths: ["library.txt"], forbiddenPaths: [] },
      },
    ],
  };
}

test("two sealed disjoint member artifacts compose in a third clone without mutating canonical product", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const group = await groupFor(repoRoot);
  const actor = { provider: "codex", actorIdHash: "sha256:root" };
  const workspaces = [];

  for (let index = 0; index < group.members.length; index += 1) {
    const member = group.members[index];
    const req = request(group, member, `artifact-${member.memberId}`);
    const baseDir = mkdtempSync(join(tmpdir(), `orchestra-member-${member.memberId}-`));
    t.after(() => rmSync(baseDir, { recursive: true, force: true }));
    const workspace = await prepareMutableDelegationWorkspace({ repoRoot, request: req, baseDir });
    workspaces.push(workspace);
    t.after(async () => { await cleanupMutableDelegationWorkspace(workspace); });
    writeFileSync(
      join(workspace.path, member.memberId === "a" ? "home.txt" : "library.txt"),
      `${member.memberId}-after\n`,
    );
    await sealDelegationArtifact({
      repoRoot,
      request: req,
      generation: group.generation,
      actor,
      workspace,
      report: { summary: "done", findings: [], evidenceRefs: [] },
      parallelBinding: { groupId: group.groupId, memberId: member.memberId },
    });
  }

  const descriptor = await composeParallelMemberArtifacts({
    repoRoot,
    group,
    memberArtifactIds: ["artifact-a", "artifact-b"],
  });
  assert.equal(descriptor.state, "READY_FOR_REVIEW");
  assert.deepEqual(descriptor.changedPaths, ["home.txt", "library.txt"]);

  const stored = readCompositeArtifact(repoRoot, descriptor.artifactId);
  assert.equal(stored.exists, true);
  assert.equal(stored.valid, true);
  assert.deepEqual(stored.manifest.memberArtifactIds, ["artifact-a", "artifact-b"]);
  assert.equal(readFileSync(join(stored.manifest.delegatedPath, "home.txt"), "utf8"), "a-after\n");
  assert.equal(readFileSync(join(stored.manifest.delegatedPath, "library.txt"), "utf8"), "b-after\n");

  assert.equal(readFileSync(join(repoRoot, "home.txt"), "utf8"), "home-before\n");
  assert.equal(readFileSync(join(repoRoot, "library.txt"), "utf8"), "library-before\n");

  t.after(() => rmSync(dirname(stored.manifest.delegatedPath), { recursive: true, force: true }));
});
