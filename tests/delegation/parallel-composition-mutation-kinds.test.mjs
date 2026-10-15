import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "orchestra-parallel-compose-kinds-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(root, "script.sh"), "#!/bin/sh\necho before\n");
  writeFileSync(join(root, "delete.txt"), "delete-me\n");
  writeFileSync(join(root, "target.txt"), "target\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  return root;
}

function packet(taskId, generation, paths, goal) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId,
    candidateGeneration: generation,
    goal,
    direction: { change: goal, preserve: ["other shard"] },
    anchors: paths.map((file) => ({ file })),
    scope: { allowedAreas: [...paths], forbidden: [] },
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
  const taskId = "task-compose-kinds";
  const generation = 9;
  const leftPaths = ["binary.bin", "script.sh"];
  const rightPaths = ["delete.txt", "new.txt", "link.txt"];
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: "group-compose-kinds",
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
        packet: packet(taskId, generation, leftPaths, "change binary and executable mode"),
        mutationScope: { allowedPaths: leftPaths, forbiddenPaths: [] },
      },
      {
        memberId: "b",
        targetProvider: "antigravity",
        packet: packet(taskId, generation, rightPaths, "create delete and symlink"),
        mutationScope: { allowedPaths: rightPaths, forbiddenPaths: [] },
      },
    ],
  };
}

test("parallel composition preserves binary, mode, create, delete, and contained symlink facts", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const group = await groupFor(repoRoot);
  const actor = { provider: "codex", actorIdHash: "sha256:root" };

  for (const member of group.members) {
    const req = request(group, member, `artifact-kinds-${member.memberId}`);
    const baseDir = mkdtempSync(join(tmpdir(), `orchestra-kinds-${member.memberId}-`));
    t.after(() => rmSync(baseDir, { recursive: true, force: true }));
    const workspace = await prepareMutableDelegationWorkspace({ repoRoot, request: req, baseDir });
    t.after(async () => { await cleanupMutableDelegationWorkspace(workspace); });

    if (member.memberId === "a") {
      writeFileSync(join(workspace.path, "binary.bin"), Buffer.from([255, 0, 9, 8, 7]));
      chmodSync(join(workspace.path, "script.sh"), 0o755);
    } else {
      unlinkSync(join(workspace.path, "delete.txt"));
      writeFileSync(join(workspace.path, "new.txt"), "created\n");
      symlinkSync("target.txt", join(workspace.path, "link.txt"));
    }

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
    memberArtifactIds: ["artifact-kinds-a", "artifact-kinds-b"],
  });
  const stored = readCompositeArtifact(repoRoot, descriptor.artifactId);
  assert.equal(stored.valid, true);
  const reviewPath = stored.manifest.delegatedPath;

  assert.deepEqual(readFileSync(join(reviewPath, "binary.bin")), Buffer.from([255, 0, 9, 8, 7]));
  assert.notEqual(lstatSync(join(reviewPath, "script.sh")).mode & 0o111, 0);
  assert.equal(existsSync(join(reviewPath, "delete.txt")), false);
  assert.equal(readFileSync(join(reviewPath, "new.txt"), "utf8"), "created\n");
  assert.equal(lstatSync(join(reviewPath, "link.txt")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(reviewPath, "link.txt")), "target.txt");

  assert.deepEqual(readFileSync(join(repoRoot, "binary.bin")), Buffer.from([0, 1, 2, 3]));
  assert.equal(lstatSync(join(repoRoot, "script.sh")).mode & 0o111, 0);
  assert.equal(readFileSync(join(repoRoot, "delete.txt"), "utf8"), "delete-me\n");
  assert.equal(existsSync(join(repoRoot, "new.txt")), false);
  assert.equal(existsSync(join(repoRoot, "link.txt")), false);

  t.after(() => rmSync(dirname(reviewPath), { recursive: true, force: true }));
});
