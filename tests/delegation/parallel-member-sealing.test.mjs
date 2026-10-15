import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDelegationGitBoundary } from "../../runtime/delegation/git-boundary.mjs";
import { readDelegationProductFingerprint } from "../../runtime/delegation/source-snapshot.mjs";
import {
  cleanupMutableDelegationWorkspace,
  prepareMutableDelegationWorkspace,
} from "../../runtime/delegation/mutable-workspace.mjs";
import { sealDelegationArtifact } from "../../runtime/delegation/artifact-lifecycle.mjs";
import { readDelegationArtifact } from "../../runtime/delegation/artifact-store.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function packet(generation) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "parallel-seal-task",
    candidateGeneration: generation,
    goal: "mutate one bounded file",
    direction: { change: "edit tracked.txt", preserve: ["everything else"] },
    anchors: [{ file: "tracked.txt" }],
    scope: { allowedAreas: ["tracked.txt"], forbidden: [] },
    permissions: {
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
      sideEffects: ["WORKSPACE_EDIT"],
    },
    validation: ["focused test"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

test("sealDelegationArtifact persists the broker-owned parallel member binding", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "orchestra-parallel-seal-source-"));
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-parallel-seal-clone-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  git(repoRoot, "init");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Orchestra Test");
  writeFileSync(join(repoRoot, "tracked.txt"), "before\n");
  git(repoRoot, "add", "tracked.txt");
  git(repoRoot, "commit", "-m", "initial");
  writeFileSync(join(repoRoot, ".git", "info", "exclude"), ".orchestra/\n", { flag: "a" });

  const identity = readDelegationProductFingerprint(repoRoot);
  const boundary = await readDelegationGitBoundary(repoRoot);
  const generation = 5;
  const request = {
    schema: "orchestra.delegation-request.v2",
    delegationId: "parallel-member-seal",
    taskId: "parallel-seal-task",
    source: { provider: "codex", actorIdHash: "sha256:root" },
    target: { provider: "codex", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: packet(generation),
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

  const workspace = await prepareMutableDelegationWorkspace({ repoRoot, request, baseDir });
  t.after(async () => { await cleanupMutableDelegationWorkspace(workspace); });
  assert.equal(workspace.canonicalGitFingerprint, boundary.fingerprint);

  writeFileSync(join(workspace.path, "tracked.txt"), "after\n");
  const artifact = await sealDelegationArtifact({
    repoRoot,
    request,
    generation,
    actor: { provider: "codex", actorIdHash: "sha256:root", actorKind: "ROOT", isRoot: true },
    workspace,
    report: { summary: "done", findings: [], evidenceRefs: [] },
    parallelBinding: { groupId: "parallel-group-seal", memberId: "local" },
  });

  const stored = readDelegationArtifact(repoRoot, artifact.artifactId);
  assert.equal(stored.valid, true);
  assert.equal(stored.manifest.parallelGroupId, "parallel-group-seal");
  assert.equal(stored.manifest.parallelMemberId, "local");
});
