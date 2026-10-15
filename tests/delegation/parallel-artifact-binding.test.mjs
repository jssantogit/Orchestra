import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { sealDelegationArtifact } from "../../runtime/delegation/artifact-lifecycle.mjs";
import { readDelegationArtifact } from "../../runtime/delegation/artifact-store.mjs";
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
  const root = mkdtempSync(join(tmpdir(), "orchestra-parallel-binding-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "member.txt"), "before\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  return root;
}

function requestFor(repoRoot) {
  const identity = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: "parallel-binding-member",
    taskId: "parallel-binding-task",
    source: { provider: "codex", actorIdHash: "sha256:root" },
    target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "parallel-binding-task",
      candidateGeneration: 4,
      goal: "seal one parallel member",
      direction: { change: "edit member.txt", preserve: ["CONTROL authority"] },
      anchors: [{ file: "member.txt" }],
      scope: { allowedAreas: ["member.txt"], forbidden: [".git/**", ".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: ["WORKSPACE_EDIT"] },
      validation: ["parallel binding is persisted"],
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
      mutationScope: { allowedPaths: ["member.txt"], forbiddenPaths: [] },
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

test("parallel member sealing persists broker-owned group binding", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const request = requestFor(repoRoot);
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-parallel-binding-workspace-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const workspace = await prepareMutableDelegationWorkspace({ repoRoot, request, baseDir });
  t.after(async () => { await cleanupMutableDelegationWorkspace(workspace); });

  writeFileSync(join(workspace.path, "member.txt"), "after\n");
  const descriptor = await sealDelegationArtifact({
    repoRoot,
    request,
    generation: 4,
    actor: { provider: "codex", actorIdHash: "sha256:root" },
    workspace,
    report: { summary: "done", findings: [], evidenceRefs: [] },
    parallelBinding: { groupId: "parallel-group-1", memberId: "member-a" },
  });

  const stored = readDelegationArtifact(repoRoot, descriptor.artifactId);
  assert.equal(stored.valid, true);
  assert.equal(stored.manifest.parallelGroupId, "parallel-group-1");
  assert.equal(stored.manifest.parallelMemberId, "member-a");
});
