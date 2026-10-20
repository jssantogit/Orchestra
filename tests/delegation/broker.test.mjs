import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep, isAbsolute } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { createDelegationBroker as createBroker } from "../../runtime/delegation/broker.mjs";
import { testResourceGovernor } from '../helpers/resource-governor.mjs';
const createDelegationBroker = (options) => createBroker({ resourceGovernor: testResourceGovernor(), ...options });
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
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-broker-"));
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
    schema: "orchestra.delegation-request.v1",
    delegationId: "broker-delegation",
    taskId: "broker-task",
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "broker-task",
      candidateGeneration: 2,
      goal: "independently review the bounded candidate",
      direction: {
        change: "inspect tracked.txt against the acceptance boundary",
        preserve: ["canonical checkout"],
      },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt"], forbidden: [".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: ["LOCAL_TEST"] },
      validation: ["tracked.txt stays unchanged"],
      failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
    },
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
      mutation: "FORBIDDEN",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: identity.fingerprint,
      sourceRevision: identity.head,
      isolation: "EPHEMERAL_WORKTREE",
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

test('legacy broker pressure defers before provider discovery or workspace preparation', async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  let calls = 0;
  const broker = createDelegationBroker({
    resourceGovernor: { reserve: () => ({ ok: false, reason: 'RESOURCE_BUDGET_UNAVAILABLE' }) },
    executors: [{ provider: 'antigravity', discover: async () => { calls++; }, execute: async () => { calls++; } }],
    workspace: { prepare: async () => { calls++; } },
  });
  const result = await broker.executeDelegation(requestFor(repoRoot), { repoRoot, generation: 7, actor: actor() });
  assert.equal(result.reason, 'RESOURCE_BUDGET_UNAVAILABLE');
  assert.equal(calls, 0);
});

function actor(overrides = {}) {
  return {
    provider: "codex",
    actorIdHash: "sha256:control",
    actorKind: "ROOT",
    isRoot: true,
    ...overrides,
  };
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function successfulExecutor({ onExecute = null } = {}) {
  return {
    provider: "antigravity",
    async discover() {
      return {
        available: true,
        provider: "antigravity",
        version: "agy-test",
        capabilities: { print: true, printTimeout: true, sandbox: true, model: true },
      };
    },
    async execute(context) {
      await onExecute?.(context);
      return {
        ok: true,
        provider: "antigravity",
        report: {
          summary: "No blocking issue found.",
          findings: [],
          evidenceRefs: ["worker:test:focused"],
        },
        execution: { exitCode: 0, durationMs: 12 },
      };
    },
  };
}

test("broker executes exact Codex to AGY target in an external worktree and returns only a canonical worker claim", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const events = [];
  let delegatedPath = null;
  let receivedEnvelope = null;

  const broker = createDelegationBroker({
    executors: [successfulExecutor({
      onExecute: async ({ request, workerEnvelope, workspace }) => {
        delegatedPath = workspace.path;
        receivedEnvelope = workerEnvelope;
        assert.equal(request.target.provider, "antigravity");
        assert.equal(existsSync(workspace.path), true);
        assert.equal(inside(repoRoot, workspace.path), false);
        assert.equal(git(workspace.path, "rev-parse", "HEAD"), request.workspace.sourceRevision);
      },
    })],
    events: { emit: (event) => events.push(event) },
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 7,
    actor: actor(),
  });

  assert.equal(result.schema, "orchestra.delegation-result.v1");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.provider, "antigravity");
  assert.equal(result.summary, "No blocking issue found.");
  assert.deepEqual(result.evidenceRefs, ["worker:test:focused"]);
  assert.deepEqual(result.execution, { exitCode: 0, durationMs: 12 });
  assert.equal(result.workspace.dirty, false);
  assert.equal(existsSync(delegatedPath), false);

  assert.equal(JSON.stringify(receivedEnvelope).includes("sourceFingerprint"), false);
  assert.equal(JSON.stringify(receivedEnvelope).includes("actorIdHash"), false);
  assert.deepEqual(events.map((event) => event.type), ["DELEGATION_STARTED", "DELEGATION_COMPLETED"]);

  const stored = readDelegationRecord(repoRoot, "broker-delegation");
  assert.equal(stored.valid, true);
  assert.equal(stored.record.status, "COMPLETED");
  assert.equal(stored.record.workspace.cleaned, true);
  assert.deepEqual(stored.record.evidenceRefs, ["worker:test:focused"]);

  assert.equal(existsSync(join(repoRoot, ".orchestra", "state", "candidates")), false);
  assert.equal(existsSync(join(repoRoot, ".orchestra", "state", "evidence")), false);
  assert.deepEqual(readdirSync(join(repoRoot, ".orchestra", "state")), ["delegations"]);
});

test("broker never falls back when the exact requested provider is unavailable", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  let fallbackCalls = 0;

  const broker = createDelegationBroker({
    executors: [
      {
        provider: "antigravity",
        async discover() { return { available: false, provider: "antigravity", reason: "PROVIDER_UNAVAILABLE" }; },
        async execute() { throw new Error("must not execute unavailable provider"); },
      },
      {
        provider: "other-provider",
        async discover() { return { available: true, provider: "other-provider" }; },
        async execute() { fallbackCalls += 1; return { ok: true }; },
      },
    ],
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 7,
    actor: actor(),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "PROVIDER_UNAVAILABLE");
  assert.equal(fallbackCalls, 0);
  assert.equal(existsSync(join(repoRoot, ".orchestra", "state", "delegations")), false);
});

test("broker fences source actor mismatches before provider discovery or workspace creation", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  let discoveryCalls = 0;
  const broker = createDelegationBroker({
    executors: [{
      provider: "antigravity",
      async discover() { discoveryCalls += 1; return { available: true, provider: "antigravity" }; },
      async execute() { throw new Error("must not execute"); },
    }],
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 7,
    actor: actor({ actorIdHash: "sha256:stale-control" }),
  });
  assert.equal(result.status, "DENIED");
  assert.equal(result.reason, "CAPABILITY_DENIED");
  assert.equal(discoveryCalls, 0);
  assert.equal(existsSync(join(repoRoot, ".orchestra")), false);
});

test("broker treats any delegated workspace mutation as a capability violation and still cleans up", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  let delegatedPath = null;
  const events = [];
  const broker = createDelegationBroker({
    executors: [successfulExecutor({
      onExecute: async ({ workspace }) => {
        delegatedPath = workspace.path;
        writeFileSync(join(workspace.path, "worker-created.txt"), "forbidden\n");
      },
    })],
    events: { emit: (event) => events.push(event) },
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 7,
    actor: actor(),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "CAPABILITY_DENIED");
  assert.equal(result.workspace.dirty, true);
  assert.equal(existsSync(delegatedPath), false);
  assert.deepEqual(events.map((event) => event.type), ["DELEGATION_STARTED", "DELEGATION_FAILED"]);

  const stored = readDelegationRecord(repoRoot, "broker-delegation");
  assert.equal(stored.record.status, "FAILED");
  assert.equal(stored.record.failureReason, "CAPABILITY_DENIED");
  assert.equal(stored.record.workspace.dirty, true);
  assert.equal(stored.record.workspace.cleaned, true);
  assert.deepEqual(stored.record.evidenceRefs, []);
});

test("broker maps executor timeout and always cleans the delegated worktree", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  let delegatedPath = null;
  const broker = createDelegationBroker({
    executors: [{
      provider: "antigravity",
      async discover() { return { available: true, provider: "antigravity" }; },
      async execute({ workspace }) {
        delegatedPath = workspace.path;
        return {
          ok: false,
          provider: "antigravity",
          reason: "EXECUTION_TIMED_OUT",
          execution: { exitCode: null, durationMs: 25 },
        };
      },
    }],
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 7,
    actor: actor(),
  });
  assert.equal(result.status, "TIMED_OUT");
  assert.equal(result.reason, "EXECUTION_TIMED_OUT");
  assert.equal(existsSync(delegatedPath), false);

  const stored = readDelegationRecord(repoRoot, "broker-delegation");
  assert.equal(stored.record.status, "TIMED_OUT");
  assert.equal(stored.record.workspace.cleaned, true);
});

test("cleanup failure overrides apparent success and preserves a bounded recoverable path", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const events = [];
  const fakePath = join(tmpdir(), "orchestra-recoverable-worktree");

  const broker = createDelegationBroker({
    executors: [successfulExecutor()],
    workspace: {
      async prepare({ request }) {
        return {
          repoRoot,
          path: fakePath,
          sourceRevision: request.workspace.sourceRevision,
          initialFingerprint: request.workspace.sourceFingerprint,
          cleanupToken: "fake-token",
        };
      },
      async inspect() {
        return { finalFingerprint: "sha256:final", dirty: false, dirtyFileCount: 0 };
      },
      async cleanup() {
        return { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
      },
    },
    events: { emit: (event) => events.push(event) },
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 7,
    actor: actor(),
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "WORKSPACE_CLEANUP_FAILED");
  assert.deepEqual(events.map((event) => event.type), ["DELEGATION_STARTED", "DELEGATION_CLEANUP_FAILED"]);

  const stored = readDelegationRecord(repoRoot, "broker-delegation");
  assert.equal(stored.record.status, "CLEANUP_FAILED");
  assert.equal(stored.record.failureReason, "WORKSPACE_CLEANUP_FAILED");
  assert.equal(stored.record.workspace.cleaned, false);
  assert.equal(stored.record.workspace.recoverablePath, fakePath);
  assert.deepEqual(stored.record.evidenceRefs, []);
});
