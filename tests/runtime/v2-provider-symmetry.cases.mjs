import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { createGlobalProjectRegistry } from "../../v2/global/project-registry.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { createCodexHookHandler } from "../../v2/providers/codex/hook-handler.mjs";
import { createAntigravityHookHandler } from "../../v2/providers/antigravity/hook-handler.mjs";

const NOW = "2026-10-17T15:00:00.000Z";
const ADAPTERS = [
  { provider: "codex", createHandler: createCodexHookHandler },
  { provider: "antigravity", createHandler: createAntigravityHookHandler },
];

function hash(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function workspace(root, name) {
  const path = join(root, name);
  execFileSync("git", ["init", "--quiet", path]);
  return path;
}

function work(workId, projectId) {
  return {
    schema: "orchestra.work-unit.v2",
    workId,
    projectId,
    taskId: `task-${workId}`,
    generation: 3,
    runtimeImage: "2.0.0",
    instructionEpoch: 7,
    state: "INTAKE",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function payload(provider, event, actorId, callId) {
  if (provider === "codex") {
    if (event === "SessionStart") return { hook_event_name: event, session_id: actorId };
    return {
      hook_event_name: event,
      session_id: actorId,
      tool_name: "write_file",
      tool_call_id: callId,
      ...(event === "PostToolUse" ? { is_error: false } : {}),
    };
  }
  if (event === "SessionStart") return { hookEventName: event, conversationId: actorId };
  return {
    hookEventName: event,
    conversationId: actorId,
    toolCall: { id: callId, name: "write_file" },
    ...(event === "PostToolUse" ? { is_error: false } : {}),
  };
}

function neutralReason(provider, reason) {
  if (reason === `${provider === "codex" ? "CODEX" : "ANTIGRAVITY"}_SESSION_OBSERVATION_MISSING`) {
    return "SESSION_OBSERVATION_MISSING";
  }
  return reason ?? null;
}

function neutralDecision(provider, response) {
  return {
    allowed: response.ok === true,
    reason: neutralReason(provider, response.reason),
    workId: response.work?.workId ?? null,
    generation: response.generation ?? null,
    currentWorkId: response.currentWorkId ?? null,
    currentGeneration: response.currentGeneration ?? null,
    liveness: response.liveness ?? response.operation?.liveness ?? null,
    workflowState: response.operation?.workflowState ?? null,
    recoveryRequired: response.recoveryRequired ?? false,
    replayed: response.replayed ?? false,
  };
}

async function prepare({ provider, root, active = true, projects = ["project-a"] }) {
  await mkdir(root, { recursive: true });
  const home = join(root, "home");
  const registry = createGlobalProjectRegistry({ home });
  const workspaces = {};
  const registered = {};
  try {
    for (const [index, projectName] of projects.entries()) {
      const cwd = workspace(root, `workspace-${projectName}`);
      workspaces[projectName] = cwd;
      const result = await registry.registerWorkspace({
        root: cwd,
        runtimeImage: "2.0.0",
        instructionEpoch: 7,
        trustMode: "trusted",
      });
      assert.equal(result.ok, true);
      registered[projectName] = result.project;
      if (active) {
        const started = registry.state.work.startCurrent(work(`work-${projectName}`, result.project.projectId));
        assert.equal(started.ok, true);
      }
    }
    return {
      home,
      workspaces,
      registered,
      registry,
      handler(now = () => NOW) {
        const createHandler = ADAPTERS.find((item) => item.provider === provider).createHandler;
        return createHandler({ registry, now });
      },
    };
  } catch (error) {
    registry.close();
    throw error;
  }
}

async function runScenario(name, scenario) {
  const outcomes = [];
  for (const adapter of ADAPTERS) {
    const root = await mkdtemp(join(tmpdir(), `orchestra-v2-symmetry-${name}-${adapter.provider}-`));
    let prepared;
    try {
      prepared = await prepare({ provider: adapter.provider, root, ...scenario.setup });
      const result = await scenario.run({ provider: adapter.provider, ...prepared });
      outcomes.push(neutralDecision(adapter.provider, result));
    } finally {
      prepared?.registry.close();
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(outcomes[0], outcomes[1], `${name} neutral outcome differs by provider`);
  return outcomes[0];
}

async function attach(handler, provider, actorId, cwd) {
  return handler.handle(payload(provider, "SessionStart", actorId), { cwd });
}

async function putObservation(registry, provider, projectId, actorId, updates = {}) {
  const current = registry.state.sessionObservations.get({
    provider,
    projectId,
    actorIdHash: hash(actorId),
  });
  assert.ok(current);
  return registry.state.sessionObservations.put({
    ...current,
    ...updates,
    observedAt: new Date(Date.parse(current.observedAt) + 1_000).toISOString(),
  });
}

async function beginMutation(handler, provider, actorId, callId, cwd) {
  return handler.handle(payload(provider, "PreToolUse", actorId, callId), { cwd });
}

test("provider symmetry: fresh attach produces the same neutral Work authority", async () => {
  const decision = await runScenario("fresh-attach", {
    run: async ({ provider, handler, workspaces }) => attach(handler(), provider, "fresh-actor", workspaces["project-a"]),
  });
  assert.deepEqual(decision, {
    allowed: true,
    reason: null,
    workId: "work-project-a",
    generation: 3,
    currentWorkId: null,
    currentGeneration: null,
    liveness: null,
    workflowState: null,
    recoveryRequired: false,
    replayed: false,
  });
});

test("provider symmetry: INTAKE grants no mutation authority", async () => {
  const decision = await runScenario("intake", {
    setup: { active: false },
    run: async ({ provider, handler, workspaces }) => attach(handler(), provider, "intake-actor", workspaces["project-a"]),
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "ORCHESTRA_V2_INTAKE");
  assert.equal(decision.workId, null);
  assert.equal(decision.generation, null);
});

test("provider symmetry: stale instruction epoch is denied with the neutral reason", async () => {
  const decision = await runScenario("stale-epoch", {
    run: async ({ provider, home, handler, workspaces, registered }) => {
      const db = new DatabaseSync(join(home, "state", "orchestra.db"));
      try {
        const row = db.prepare("SELECT record_json FROM projects WHERE project_id = ?").get(registered["project-a"].projectId);
        const project = JSON.parse(row.record_json);
        project.runtime.instructionEpoch = 8;
        db.prepare("UPDATE projects SET record_json = ? WHERE project_id = ?")
          .run(JSON.stringify(project), registered["project-a"].projectId);
      } finally {
        db.close();
      }
      return attach(handler(), provider, "epoch-actor", workspaces["project-a"]);
    },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "SESSION_RUNTIME_STALE");
});

test("provider symmetry: stale active Work is denied with the neutral reason", async () => {
  const decision = await runScenario("stale-work", {
    run: async ({ provider, handler, registry, workspaces, registered }) => {
      const actorId = "stale-work-actor";
      await attach(handler(), provider, actorId, workspaces["project-a"]);
      assert.equal(registry.state.work.open(work("previous-work", registered["project-a"].projectId)).ok, true);
      assert.equal((await putObservation(registry, provider, registered["project-a"].projectId, actorId, {
        observedWorkId: "previous-work",
      })).ok, true);
      return beginMutation(handler(), provider, actorId, "stale-work-call", workspaces["project-a"]);
    },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "STALE_ACTIVE_WORK");
  assert.equal(decision.currentWorkId, "work-project-a");
});

test("provider symmetry: stale generation is denied with the neutral reason", async () => {
  const decision = await runScenario("stale-generation", {
    run: async ({ provider, handler, registry, workspaces, registered }) => {
      const actorId = "stale-generation-actor";
      await attach(handler(), provider, actorId, workspaces["project-a"]);
      assert.equal((await putObservation(registry, provider, registered["project-a"].projectId, actorId, {
        observedGeneration: 2,
      })).ok, true);
      return beginMutation(handler(), provider, actorId, "stale-generation-call", workspaces["project-a"]);
    },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "STALE_GENERATION");
});

test("provider symmetry: provider-event mutation begins and terminalizes the same neutral operation", async () => {
  const begins = [];
  const terminals = [];
  for (const adapter of ADAPTERS) {
    const root = await mkdtemp(join(tmpdir(), `orchestra-v2-symmetry-provider-event-${adapter.provider}-`));
    let prepared;
    try {
      prepared = await prepare({ provider: adapter.provider, root });
      const actorId = "lifecycle-actor";
      const activeHandler = prepared.handler();
      await attach(activeHandler, adapter.provider, actorId, prepared.workspaces["project-a"]);
      const begun = await beginMutation(
        activeHandler,
        adapter.provider,
        actorId,
        "lifecycle-call",
        prepared.workspaces["project-a"],
      );
      assert.equal(begun.ok, true);
      const operation = prepared.registry.state.operations.inspect(begun.operation.operationId);
      assert.ok(operation);
      const ownerStore = createRuntimeOwnerStore({ rootDir: join(prepared.home, "runtime-owners") });
      const owner = await ownerStore.read(operation.runtimeOwnerRef);
      begins.push({
        allowed: begun.ok,
        reason: begun.reason ?? null,
        workId: operation.workId,
        generation: operation.generation,
        kind: operation.kind,
        capabilities: operation.capabilities,
        workflowState: operation.workflowState,
        liveness: operation.liveness,
        ownerKind: owner?.kind ?? null,
        ownerHasProcess: Object.hasOwn(owner ?? {}, "process"),
      });
      const terminal = await activeHandler.handle(
        payload(adapter.provider, "PostToolUse", actorId, "lifecycle-call"),
        { cwd: prepared.workspaces["project-a"] },
      );
      terminals.push(neutralDecision(adapter.provider, terminal));
    } finally {
      prepared?.registry.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  assert.deepEqual(begins[0], begins[1]);
  assert.deepEqual(begins[0], {
    allowed: true,
    reason: null,
    workId: "work-project-a",
    generation: 3,
    kind: "DIRECT_MUTATION",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    ownerKind: "PROVIDER_EVENT",
    ownerHasProcess: false,
  });
  assert.deepEqual(terminals[0], terminals[1]);
  assert.equal(terminals[0].allowed, true);
  assert.equal(terminals[0].reason, null);
  assert.equal(terminals[0].workflowState, "SUCCEEDED");
  assert.equal(terminals[0].liveness, "TERMINAL");
});

test("provider symmetry: observations cannot authorize mutation in another project", async () => {
  const decision = await runScenario("cross-project", {
    setup: { projects: ["project-a", "project-b"] },
    run: async ({ provider, handler, workspaces }) => {
      const activeHandler = handler();
      await attach(activeHandler, provider, "cross-project-actor", workspaces["project-a"]);
      return beginMutation(activeHandler, provider, "cross-project-actor", "cross-project-call", workspaces["project-b"]);
    },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "SESSION_OBSERVATION_MISSING");
});

test("provider symmetry: stale provider event blocks mutation pending recovery", async () => {
  const decision = await runScenario("recovery-required", {
    run: async ({ provider, handler, registry, workspaces }) => {
      const actorId = "recovery-actor";
      const activeHandler = handler();
      await attach(activeHandler, provider, actorId, workspaces["project-a"]);
      const first = await beginMutation(activeHandler, provider, actorId, "recovery-call", workspaces["project-a"]);
      assert.equal(first.ok, true);
      const operation = registry.state.operations.inspect(first.operation.operationId);
      const afterDeadline = new Date(Date.parse(operation.deadlineAt) + 1_000).toISOString();
      return beginMutation(handler(() => afterDeadline), provider, actorId, "recovery-call", workspaces["project-a"]);
    },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "STALE_OPERATION_RECOVERY_REQUIRED");
  assert.equal(decision.liveness, "STALE_RECOVERABLE");
  assert.equal(decision.recoveryRequired, true);
});
