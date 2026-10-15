import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { createDelegationBroker } from "../../runtime/delegation/broker.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-generation-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

function requestFor(repoRoot) {
  const identity = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: "stale-generation-v2",
    taskId: "stale-generation-task",
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "stale-generation-task",
      candidateGeneration: 9,
      goal: "implement bounded change",
      direction: { change: "edit tracked.txt", preserve: ["CONTROL authority"] },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt"], forbidden: [] },
      permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: ["WORKSPACE_EDIT"] },
      validation: ["focused tests"],
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

test("v2 stale candidate generation is denied before provider discovery or workspace allocation", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  let discoveryCalls = 0;
  let executionCalls = 0;
  let prepareCalls = 0;
  const broker = createDelegationBroker({
    executors: [{
      provider: "antigravity",
      async discover() {
        discoveryCalls += 1;
        return { available: true, provider: "antigravity" };
      },
      async execute() {
        executionCalls += 1;
        throw new Error("must not execute stale generation");
      },
    }],
    mutableWorkspace: {
      async prepare() {
        prepareCalls += 1;
        throw new Error("must not allocate stale generation");
      },
      async inspect() { throw new Error("must not inspect"); },
      async cleanup() { throw new Error("must not cleanup"); },
    },
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 8,
    actor: {
      provider: "codex",
      actorIdHash: "sha256:control",
      actorKind: "ROOT",
      isRoot: true,
    },
  });

  assert.equal(result.schema, "orchestra.delegation-result.v2");
  assert.equal(result.status, "DENIED");
  assert.equal(result.reason, "CAPABILITY_DENIED");
  assert.equal(result.workspace.delegatedPath, "UNALLOCATED");
  assert.equal(discoveryCalls, 0);
  assert.equal(executionCalls, 0);
  assert.equal(prepareCalls, 0);
});
