import test from "node:test";
import assert from "node:assert/strict";

import { createReferenceState } from "../../v2/state/reference-state.mjs";

function makeProject(overrides = {}) {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-a",
    lineageId: "lineage-a",
    workspace: { canonicalRoot: "C:/Projects/A", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
    ...overrides,
  };
}

function makeWork(overrides = {}) {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-a",
    projectId: "prj-a",
    taskId: "task-a",
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
    ...overrides,
  };
}

function makeOperation(overrides = {}) {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-a",
    projectId: "prj-a",
    workId: "work-a",
    generation: 0,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:one",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-16T22:00:00.000Z",
    heartbeatAt: "2026-10-16T22:00:00.000Z",
    deadlineAt: "2026-10-16T22:10:00.000Z",
    runtimeOwnerRef: "process:100:token-a",
    workspaceRef: "workspace:canonical",
    resultRef: null,
    ...overrides,
  };
}

function seededState() {
  const state = createReferenceState();
  assert.equal(state.projects.register(makeProject()).ok, true);
  assert.equal(state.work.open(makeWork()).ok, true);
  return state;
}

test("project registration is idempotent but conflicting identity fails closed", () => {
  const state = createReferenceState();
  const project = makeProject();

  const first = state.projects.register(project);
  const replay = state.projects.register(project);
  const conflict = state.projects.register(makeProject({ lineageId: "lineage-other" }));

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "PROJECT_ID_CONFLICT");
});

test("two projects cannot claim the same canonical workspace", () => {
  const state = createReferenceState();
  state.projects.register(makeProject());

  const second = state.projects.register(makeProject({
    projectId: "prj-b",
    lineageId: "lineage-b",
  }));

  assert.equal(second.ok, false);
  assert.equal(second.reason, "WORKSPACE_ALREADY_REGISTERED");
});

test("project rebind uses expected-root compare-and-swap and preserves uniqueness", () => {
  const state = createReferenceState();
  state.projects.register(makeProject());
  state.projects.register(makeProject({
    projectId: "prj-b",
    lineageId: "lineage-b",
    workspace: { canonicalRoot: "C:/Projects/B", vcs: "git" },
  }));

  const stale = state.projects.rebind({
    projectId: "prj-a",
    expectedRoot: "C:/Projects/Old-A",
    newRoot: "C:/Projects/A2",
  });
  const collision = state.projects.rebind({
    projectId: "prj-a",
    expectedRoot: "C:/Projects/A",
    newRoot: "C:/Projects/B",
  });
  const moved = state.projects.rebind({
    projectId: "prj-a",
    expectedRoot: "C:/Projects/A",
    newRoot: "C:/Projects/A2",
  });

  assert.equal(stale.reason, "STALE_PROJECT_ROOT");
  assert.equal(collision.reason, "WORKSPACE_ALREADY_REGISTERED");
  assert.equal(moved.ok, true);
  assert.equal(state.projects.resolve("C:/Projects/A"), null);
  assert.equal(state.projects.resolve("C:/Projects/A2").projectId, "prj-a");
});

test("work transition is generation-CAS and increments generation exactly once", () => {
  const state = seededState();

  const result = state.work.transition({
    projectId: "prj-a",
    workId: "work-a",
    expectedGeneration: 0,
    transitionId: "tr-1",
    patch: { state: "PLANNED", scopeRef: "scope:a" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.work.generation, 1);
  assert.equal(result.work.state, "PLANNED");
  assert.equal(result.work.scopeRef, "scope:a");
  assert.equal(state.work.read("prj-a", "work-a").generation, 1);
});

test("stale work transition cannot mutate durable state", () => {
  const state = seededState();
  state.work.transition({
    projectId: "prj-a",
    workId: "work-a",
    expectedGeneration: 0,
    transitionId: "tr-1",
    patch: { state: "PLANNED" },
  });

  const stale = state.work.transition({
    projectId: "prj-a",
    workId: "work-a",
    expectedGeneration: 0,
    transitionId: "tr-2",
    patch: { state: "IMPLEMENTING" },
  });

  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "STALE_GENERATION");
  assert.equal(stale.currentGeneration, 1);
  assert.equal(state.work.read("prj-a", "work-a").state, "PLANNED");
});

test("replaying the same transition is idempotent and does not bump generation twice", () => {
  const state = seededState();
  const command = {
    projectId: "prj-a",
    workId: "work-a",
    expectedGeneration: 0,
    transitionId: "tr-stable",
    patch: { state: "PLANNED" },
  };

  const first = state.work.transition(command);
  const replay = state.work.transition(command);

  assert.equal(first.work.generation, 1);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.work.generation, 1);
  assert.equal(state.work.read("prj-a", "work-a").generation, 1);
});

test("reusing an idempotency key with different work content fails closed", () => {
  const state = seededState();
  state.work.transition({
    projectId: "prj-a",
    workId: "work-a",
    expectedGeneration: 0,
    transitionId: "tr-stable",
    patch: { state: "PLANNED" },
  });

  const conflict = state.work.transition({
    projectId: "prj-a",
    workId: "work-a",
    expectedGeneration: 0,
    transitionId: "tr-stable",
    patch: { state: "BLOCKED" },
  });

  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "IDEMPOTENCY_CONFLICT");
  assert.equal(state.work.read("prj-a", "work-a").state, "PLANNED");
});

test("work identity fields cannot be mutated through a transition patch", () => {
  const state = seededState();
  const result = state.work.transition({
    projectId: "prj-a",
    workId: "work-a",
    expectedGeneration: 0,
    transitionId: "tr-identity",
    patch: { projectId: "prj-other" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "IMMUTABLE_WORK_IDENTITY");
  assert.equal(state.work.read("prj-a", "work-a").projectId, "prj-a");
});

test("operation begin rejects cross-project and stale-generation references", () => {
  const state = seededState();

  const crossProject = state.operations.begin({
    expectedGeneration: 0,
    operation: makeOperation({ projectId: "prj-other" }),
  });
  const stale = state.operations.begin({
    expectedGeneration: 1,
    operation: makeOperation(),
  });

  assert.equal(crossProject.reason, "OPERATION_PROJECT_MISMATCH");
  assert.equal(stale.reason, "STALE_GENERATION");
  assert.equal(state.operations.inspect("op-a"), null);
});

test("live mutation exclusivity is workspace-scoped, preserving parallel clone execution", () => {
  const state = seededState();
  const first = state.operations.begin({ expectedGeneration: 0, operation: makeOperation() });
  const sameWorkspace = state.operations.begin({
    expectedGeneration: 0,
    operation: makeOperation({ operationId: "op-b", actorRef: "actor:two" }),
  });
  const separateClone = state.operations.begin({
    expectedGeneration: 0,
    operation: makeOperation({
      operationId: "op-c",
      actorRef: "actor:three",
      workspaceRef: "workspace:clone-c",
      runtimeOwnerRef: "process:300:token-c",
    }),
  });

  assert.equal(first.ok, true);
  assert.equal(sameWorkspace.ok, false);
  assert.equal(sameWorkspace.reason, "INCOMPATIBLE_LIVE_OPERATION");
  assert.equal(separateClone.ok, true);
});

test("operation heartbeat requires the registered runtime owner proof", () => {
  const state = seededState();
  state.operations.begin({ expectedGeneration: 0, operation: makeOperation() });

  const wrongOwner = state.operations.heartbeat({
    operationId: "op-a",
    runtimeOwnerRef: "process:999:wrong",
    heartbeatAt: "2026-10-16T22:01:00.000Z",
  });
  const updated = state.operations.heartbeat({
    operationId: "op-a",
    runtimeOwnerRef: "process:100:token-a",
    heartbeatAt: "2026-10-16T22:01:00.000Z",
  });

  assert.equal(wrongOwner.reason, "OWNER_PROOF_MISMATCH");
  assert.equal(updated.ok, true);
  assert.equal(updated.operation.heartbeatAt, "2026-10-16T22:01:00.000Z");
});

test("operation terminalization is idempotent and cannot be rewritten to a conflicting result", () => {
  const state = seededState();
  state.operations.begin({ expectedGeneration: 0, operation: makeOperation() });

  const first = state.operations.terminalize({
    operationId: "op-a",
    workflowState: "COMPLETED",
    resultRef: "result:one",
  });
  const replay = state.operations.terminalize({
    operationId: "op-a",
    workflowState: "COMPLETED",
    resultRef: "result:one",
  });
  const conflict = state.operations.terminalize({
    operationId: "op-a",
    workflowState: "FAILED",
    resultRef: "result:two",
  });

  assert.equal(first.ok, true);
  assert.equal(first.operation.liveness, "TERMINAL");
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "TERMINAL_RESULT_CONFLICT");
  assert.equal(state.operations.inspect("op-a").resultRef, "result:one");
});

test("project A state never resolves or mutates project B work", () => {
  const state = createReferenceState();
  state.projects.register(makeProject());
  state.projects.register(makeProject({
    projectId: "prj-b",
    lineageId: "lineage-b",
    workspace: { canonicalRoot: "C:/Projects/B", vcs: "git" },
  }));
  state.work.open(makeWork());
  state.work.open(makeWork({ workId: "work-b", projectId: "prj-b", taskId: "task-b" }));

  assert.equal(state.work.read("prj-a", "work-b"), null);
  const wrongNamespace = state.work.transition({
    projectId: "prj-a",
    workId: "work-b",
    expectedGeneration: 0,
    transitionId: "tr-cross",
    patch: { state: "PLANNED" },
  });

  assert.equal(wrongNamespace.ok, false);
  assert.equal(wrongNamespace.reason, "WORK_PROJECT_MISMATCH");
  assert.equal(state.work.read("prj-b", "work-b").state, "INTAKE");
});
