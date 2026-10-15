import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { readDelegationArtifact } from "../../runtime/delegation/artifact-store.mjs";
import { createDelegationBroker } from "../../runtime/delegation/broker.mjs";
import { readDelegationRecord } from "../../runtime/delegation/store.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-broker-v2-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

function requestFor(repoRoot, overrides = {}) {
  const identity = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  const base = {
    schema: "orchestra.delegation-request.v2",
    delegationId: "broker-v2-delegation",
    taskId: "broker-v2-task",
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "broker-v2-task",
      candidateGeneration: 9,
      goal: "implement the bounded candidate change",
      direction: {
        change: "update tracked.txt",
        preserve: ["canonical checkout until CONTROL promotion"],
      },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt"], forbidden: [".orchestra/state/**"] },
      permissions: {
        discovery: "DIRECTED",
        tests: "MODIFY_AUTHORIZED_TARGETS",
        sideEffects: ["WORKSPACE_EDIT", "LOCAL_TEST"],
      },
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
  return {
    ...base,
    ...overrides,
    source: { ...base.source, ...(overrides.source ?? {}) },
    target: { ...base.target, ...(overrides.target ?? {}) },
    workspace: { ...base.workspace, ...(overrides.workspace ?? {}) },
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

function executor({ onExecute = null, outcome = null, available = true } = {}) {
  return {
    provider: "antigravity",
    async discover() {
      return available
        ? { available: true, provider: "antigravity", version: "agy-test" }
        : { available: false, provider: "antigravity", reason: "PROVIDER_UNAVAILABLE" };
    },
    async execute(context) {
      await onExecute?.(context);
      return outcome ?? {
        ok: true,
        provider: "antigravity",
        report: {
          summary: "Bounded implementation complete.",
          findings: [],
          evidenceRefs: ["test:focused"],
        },
        execution: { exitCode: 0, durationMs: 23 },
      };
    },
  };
}

function cleanupRetained(result) {
  const path = result?.workspace?.delegatedPath;
  if (typeof path === "string" && path && path !== "UNALLOCATED") {
    rmSync(dirname(path), { recursive: true, force: true });
  }
}

test("v2 broker seals authorized worker mutation, retains review clone, and leaves canonical product unchanged", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const broker = createDelegationBroker({
    executors: [executor({
      onExecute: async ({ workspace, workerEnvelope }) => {
        assert.equal(workspace.workerGitEnv.GIT_CONFIG_NOSYSTEM, "1");
        assert.deepEqual(workerEnvelope.scope.mutationScope.allowedPaths, ["tracked.txt"]);
        writeFileSync(join(workspace.path, "tracked.txt"), "implemented\n");
      },
    })],
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 9,
    actor: actor(),
  });
  t.after(() => cleanupRetained(result));

  assert.equal(result.schema, "orchestra.delegation-result.v2");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.provider, "antigravity");
  assert.deepEqual(result.workspace.changedPaths, ["tracked.txt"]);
  assert.equal(result.workspace.dirty, true);
  assert.equal(existsSync(result.workspace.delegatedPath), true);
  assert.equal(readFileSync(join(result.workspace.delegatedPath, "tracked.txt"), "utf8"), "implemented\n");
  assert.equal(readFileSync(join(repoRoot, "tracked.txt"), "utf8"), "canonical\n");
  assert.equal(git(repoRoot, "diff", "--", "tracked.txt"), "");

  assert.equal(result.artifact.state, "READY_FOR_REVIEW");
  assert.equal(result.artifact.artifactId, "broker-v2-delegation");
  assert.deepEqual(result.artifact.changedPaths, ["tracked.txt"]);

  const artifact = readDelegationArtifact(repoRoot, result.artifact.artifactId);
  assert.equal(artifact.exists, true);
  assert.equal(artifact.valid, true);
  assert.equal(artifact.manifest.delegatedPath, result.workspace.delegatedPath);
  assert.equal(artifact.manifest.patchSha256, result.artifact.patchSha256);
  assert.equal(artifact.manifest.mutationDigest, result.artifact.mutationDigest);

  const stored = readDelegationRecord(repoRoot, "broker-v2-delegation");
  assert.equal(stored.valid, true);
  assert.equal(stored.record.status, "COMPLETED");
  assert.equal(stored.record.artifactId, result.artifact.artifactId);
  assert.equal(stored.record.workspace.cleaned, false);
  assert.equal(stored.record.workspace.retained, true);
  assert.equal(stored.record.workspace.recoverablePath, result.workspace.delegatedPath);

  assert.equal(existsSync(join(repoRoot, ".orchestra", "state", "candidates")), false);
  assert.equal(existsSync(join(repoRoot, ".orchestra", "state", "evidence")), false);
});

test("v2 broker represents pre-workspace provider unavailability factually and never falls back", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  let fallbackCalls = 0;
  const broker = createDelegationBroker({
    executors: [
      executor({ available: false }),
      {
        provider: "other-provider",
        async discover() { return { available: true, provider: "other-provider" }; },
        async execute() { fallbackCalls += 1; return { ok: true }; },
      },
    ],
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 9,
    actor: actor(),
  });

  assert.equal(result.schema, "orchestra.delegation-result.v2");
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "PROVIDER_UNAVAILABLE");
  assert.equal(result.workspace.delegatedPath, "UNALLOCATED");
  assert.deepEqual(result.workspace.changedPaths, []);
  assert.equal(result.workspace.dirty, false);
  assert.equal("artifact" in result, false);
  assert.equal(fallbackCalls, 0);
  assert.equal(existsSync(join(repoRoot, ".orchestra", "state", "delegations")), false);
});

test("v2 executor failure cleans the isolated clone and returns no promotable artifact", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  let delegatedPath = null;
  const broker = createDelegationBroker({
    executors: [executor({
      onExecute: async ({ workspace }) => { delegatedPath = workspace.path; },
      outcome: {
        ok: false,
        provider: "antigravity",
        reason: "EXECUTION_TIMED_OUT",
        execution: { exitCode: null, durationMs: 31 },
      },
    })],
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 9,
    actor: actor(),
  });

  assert.equal(result.schema, "orchestra.delegation-result.v2");
  assert.equal(result.status, "TIMED_OUT");
  assert.equal(result.reason, "EXECUTION_TIMED_OUT");
  assert.equal(result.workspace.delegatedPath, delegatedPath);
  assert.equal(existsSync(delegatedPath), false);
  assert.equal("artifact" in result, false);

  const stored = readDelegationRecord(repoRoot, "broker-v2-delegation");
  assert.equal(stored.record.status, "TIMED_OUT");
  assert.equal(stored.record.workspace.cleaned, true);
  assert.equal(stored.record.workspace.retained, false);
});

test("v2 out-of-scope mutation returns SCOPE_VIOLATION, cleans clone, and never seals an artifact", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  let delegatedPath = null;
  const broker = createDelegationBroker({
    executors: [executor({
      onExecute: async ({ workspace }) => {
        delegatedPath = workspace.path;
        writeFileSync(join(workspace.path, "forbidden.txt"), "blocked\n");
      },
    })],
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 9,
    actor: actor(),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "SCOPE_VIOLATION");
  assert.equal("artifact" in result, false);
  assert.equal(existsSync(delegatedPath), false);
  assert.equal(readDelegationArtifact(repoRoot, "broker-v2-delegation").exists, false);
  assert.equal(readFileSync(join(repoRoot, "tracked.txt"), "utf8"), "canonical\n");
});
