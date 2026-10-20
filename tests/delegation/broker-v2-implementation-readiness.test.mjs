import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { createDelegationBroker } from '../helpers/resource-governor.mjs';

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-broker-v2-readiness-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "baseline\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

function requestFor(repoRoot) {
  const identity = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: "broker-v2-provider-readiness",
    taskId: "broker-v2-provider-readiness-task",
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "broker-v2-provider-readiness-task",
      candidateGeneration: 12,
      goal: "implement the bounded change",
      direction: { change: "edit tracked.txt", preserve: ["canonical checkout"] },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt"], forbidden: [".orchestra/state/**"] },
      permissions: {
        discovery: "DIRECTED",
        tests: "MODIFY_AUTHORIZED_TARGETS",
        sideEffects: ["WORKSPACE_EDIT"],
      },
      validation: ["bounded implementation"],
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

function actor() {
  return {
    provider: "codex",
    actorIdHash: "sha256:control",
    actorKind: "ROOT",
    isRoot: true,
  };
}

function brokerForDiscovery(discovery) {
  let prepareCalls = 0;
  let executeCalls = 0;
  const broker = createDelegationBroker({
    executors: [{
      provider: "antigravity",
      async discover() { return discovery; },
      async execute() {
        executeCalls += 1;
        throw new Error("must not execute");
      },
    }],
    mutableWorkspace: {
      async prepare() {
        prepareCalls += 1;
        throw new Error("must not allocate");
      },
      async inspect() { throw new Error("must not inspect"); },
      async cleanup() { throw new Error("must not cleanup"); },
    },
  });
  return {
    broker,
    prepareCalls: () => prepareCalls,
    executeCalls: () => executeCalls,
  };
}

async function assertUnavailableBeforeWorkspace(t, discovery) {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const fixture = brokerForDiscovery(discovery);

  const result = await fixture.broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 12,
    actor: actor(),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "PROVIDER_UNAVAILABLE");
  assert.equal(fixture.prepareCalls(), 0);
  assert.equal(fixture.executeCalls(), 0);
}

test("v2 explicit implementation=false returns PROVIDER_UNAVAILABLE before clone allocation", async (t) => {
  await assertUnavailableBeforeWorkspace(t, {
    available: true,
    provider: "antigravity",
    version: "agy-old",
    capabilities: { implementation: false },
  });
});

test("v2 missing implementation capability fails closed before clone allocation", async (t) => {
  await assertUnavailableBeforeWorkspace(t, {
    available: true,
    provider: "antigravity",
    version: "agy-unknown-capability",
    capabilities: {},
  });
});
