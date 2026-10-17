import test from "node:test";
import assert from "node:assert/strict";

import { createReferenceState } from "../../v2/state/reference-state.mjs";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-retry",
    lineageId: "lineage-retry",
    workspace: { canonicalRoot: "C:/Projects/Retry", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-retry",
    projectId: "prj-retry",
    taskId: "task-retry",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 1,
    state: "INTAKE",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function operation(overrides = {}) {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-retry",
    projectId: "prj-retry",
    workId: "work-retry",
    generation: 0,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:retry",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-16T22:00:00.000Z",
    heartbeatAt: "2026-10-16T22:00:00.000Z",
    deadlineAt: "2026-10-16T22:10:00.000Z",
    runtimeOwnerRef: "process:retry:token",
    workspaceRef: "workspace:canonical",
    resultRef: null,
    ...overrides,
  };
}

function seeded() {
  const state = createReferenceState();
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  return state;
}

test("retrying WorkUnit open after later transitions returns current work instead of false conflict", () => {
  const state = seeded();
  state.work.transition({
    projectId: "prj-retry",
    workId: "work-retry",
    expectedGeneration: 0,
    transitionId: "transition-1",
    patch: { state: "PLANNED" },
  });

  const replay = state.work.open(work());

  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.work.generation, 1);
  assert.equal(replay.work.state, "PLANNED");
});

test("retrying Operation begin after heartbeat returns current operation instead of false conflict", () => {
  const state = seeded();
  const request = operation();
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: request }).ok, true);
  assert.equal(state.operations.heartbeat({
    operationId: "op-retry",
    runtimeOwnerRef: "process:retry:token",
    heartbeatAt: "2026-10-16T22:01:00.000Z",
  }).ok, true);

  const replay = state.operations.begin({ expectedGeneration: 0, operation: request });

  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.operation.heartbeatAt, "2026-10-16T22:01:00.000Z");
});

test("mutation operation cannot begin without a factual workspace reference", () => {
  const state = seeded();
  const result = state.operations.begin({
    expectedGeneration: 0,
    operation: operation({ workspaceRef: null }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "MUTATION_WORKSPACE_REQUIRED");
  assert.equal(state.operations.inspect("op-retry"), null);
});

test("new operation cannot begin already stale or unknown", () => {
  const state = seeded();
  const result = state.operations.begin({
    expectedGeneration: 0,
    operation: operation({ liveness: "UNKNOWN" }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "OPERATION_BEGIN_NOT_LIVE");
  assert.equal(state.operations.inspect("op-retry"), null);
});
