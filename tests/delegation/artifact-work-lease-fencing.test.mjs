import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import {
  discardDelegationArtifact,
  promoteDelegationArtifact,
  sealDelegationArtifact,
} from "../../runtime/delegation/artifact-lifecycle.mjs";
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
  const root = mkdtempSync(join(tmpdir(), "orchestra-artifact-lease-fence-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "worker.txt"), "before\n");
  git(root, "add", ".");
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
      candidateGeneration: 7,
      goal: "produce one promotable worker mutation",
      direction: { change: "edit worker.txt", preserve: ["CONTROL authority"] },
      anchors: [{ file: "worker.txt" }],
      scope: { allowedAreas: ["worker.txt"], forbidden: [".git/**", ".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: ["WORKSPACE_EDIT"] },
      validation: ["sealed artifact integrity"],
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
      mutationScope: { allowedPaths: ["worker.txt"], forbiddenPaths: [] },
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

function actor() {
  return {
    provider: "provider-a",
    actorIdHash: "sha256:source",
    actorKind: "ROOT",
    isRoot: true,
  };
}

function writeLease(repoRoot, { generation = 8, provider = "provider-a", sessionIdHash = "sha256:source", capabilities = ["CONTROL"] } = {}) {
  const path = join(repoRoot, ".orchestra", "state", "work-lease.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema: "orchestra.work-lease.v1",
    projectLineage: "workspace-test",
    workspaceId: "primary",
    taskId: "newer-control-task",
    generation,
    state: "CONTROL",
    actor: { provider, sessionIdHash },
    capabilities,
    candidate: null,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function sealedFixture(t, id) {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const request = requestFor(repoRoot, id);
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-artifact-lease-review-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const workspace = await prepareMutableDelegationWorkspace({ repoRoot, request, baseDir });
  t.after(async () => { await cleanupMutableDelegationWorkspace(workspace); });
  writeFileSync(join(workspace.path, "worker.txt"), "after\n");
  const descriptor = await sealDelegationArtifact({
    repoRoot,
    request,
    generation: 7,
    actor: actor(),
    workspace,
    report: { summary: "worker claim", findings: [], evidenceRefs: [] },
  });
  return { repoRoot, workspace, descriptor };
}

test("promotion is stale when the canonical Work Lease generation advanced after sealing", async (t) => {
  const fixture = await sealedFixture(t, "artifact-stale-work-lease-promote");
  writeLease(fixture.repoRoot, { generation: 8 });

  const result = await promoteDelegationArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.descriptor.artifactId,
    generation: 7,
    actor: actor(),
  });

  assert.deepEqual(result, { promoted: false, reason: "PROMOTION_STALE", changedPaths: [] });
  assert.equal(readDelegationArtifact(fixture.repoRoot, fixture.descriptor.artifactId).manifest.state, "READY_FOR_REVIEW");
});

test("discard is stale when the canonical Work Lease generation advanced after sealing", async (t) => {
  const fixture = await sealedFixture(t, "artifact-stale-work-lease-discard");
  writeLease(fixture.repoRoot, { generation: 8 });

  const result = await discardDelegationArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.descriptor.artifactId,
    generation: 7,
    actor: actor(),
  });

  assert.deepEqual(result, { discarded: false, reason: "PROMOTION_STALE" });
  assert.equal(readDelegationArtifact(fixture.repoRoot, fixture.descriptor.artifactId).manifest.state, "READY_FOR_REVIEW");
});
