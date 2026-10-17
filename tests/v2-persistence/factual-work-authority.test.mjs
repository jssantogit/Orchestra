import test from "node:test";
import assert from "node:assert/strict";

import { createWorkAuthority } from "../../v2/authority/work-authority.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-factual-authority",
    lineageId: "lineage-factual-authority",
    workspace: { canonicalRoot: "C:/Projects/FactualAuthority", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 4 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-factual-authority",
    projectId: "prj-factual-authority",
    taskId: "task-factual-authority",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 4,
    state: "IMPLEMENTING",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function actor() {
  return {
    schema: "orchestra.actor-provenance.v2",
    provider: "codex",
    subjectHash: "sha256:factual-authority",
    source: "PROVIDER_FACT",
    observedAt: "2026-10-17T02:30:00.000Z",
  };
}

function operation({ operationId = "op-existing", workspaceRef = "workspace:canonical" } = {}) {
  return {
    schema: "orchestra.operation.v2",
    operationId,
    projectId: "prj-factual-authority",
    workId: "work-factual-authority",
    generation: 0,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:existing",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T02:20:00.000Z",
    heartbeatAt: "2026-10-17T02:20:00.000Z",
    deadlineAt: "2026-10-17T02:25:00.000Z",
    runtimeOwnerRef: `owner:${operationId}`,
    workspaceRef,
    resultRef: null,
  };
}

function seeded({ existingWorkspace = "workspace:canonical" } = {}) {
  const state = createReferenceState();
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  assert.equal(state.operations.begin({
    expectedGeneration: 0,
    operation: operation({ workspaceRef: existingWorkspace }),
  }).ok, true);
  return state;
}

function assessor(liveness, reason = "fixture") {
  return {
    async assess(op) {
      return {
        schema: "orchestra.liveness-assessment.v2",
        operationId: op.operationId,
        observedAt: "2026-10-17T02:30:00.000Z",
        liveness,
        reason,
        evidence: { ownerStatus: null, heartbeatFresh: null, deadlineExpired: null },
      };
    },
  };
}

async function authorize(authority, workspaceRef = "workspace:canonical") {
  return authority.authorize({
    projectId: "prj-factual-authority",
    expectedWorkId: "work-factual-authority",
    actor: actor(),
    observedInstructionEpoch: 4,
    capability: "WORKSPACE_EDIT",
    workspaceRef,
    expectedGeneration: 0,
  });
}

test("persisted LIVE plus factual LIVE blocks as an incompatible live writer", async () => {
  const state = seeded();
  const authority = createWorkAuthority({ state, operationLiveness: assessor("LIVE", "OWNER_MATCH_HEARTBEAT_FRESH") });
  const result = await authorize(authority);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "INCOMPATIBLE_LIVE_OPERATION");
  assert.equal(result.operation, "op-existing");
});

test("persisted LIVE plus UNKNOWN is not silently treated as live or dead", async () => {
  const state = seeded();
  const authority = createWorkAuthority({ state, operationLiveness: assessor("UNKNOWN", "OWNER_OBSERVATION_UNAVAILABLE") });
  const result = await authorize(authority);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "OPERATION_LIVENESS_UNKNOWN");
  assert.equal(result.operation, "op-existing");
  assert.equal(result.livenessReason, "OWNER_OBSERVATION_UNAVAILABLE");
});

test("persisted LIVE plus factual stale requires official recovery instead of remaining a fake live lock", async () => {
  const state = seeded();
  const authority = createWorkAuthority({ state, operationLiveness: assessor("STALE_RECOVERABLE", "OWNER_ABSENT_BOUNDED_STALE") });
  const result = await authorize(authority);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "STALE_OPERATION_RECOVERY_REQUIRED");
  assert.equal(result.operation, "op-existing");
  assert.equal(result.livenessReason, "OWNER_ABSENT_BOUNDED_STALE");
});

test("missing liveness service fails closed when a persisted candidate could conflict", async () => {
  const state = seeded();
  const authority = createWorkAuthority({ state });
  const result = await authorize(authority);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "OPERATION_LIVENESS_UNAVAILABLE");
  assert.equal(result.operation, "op-existing");
});

test("unknown writer in a different factual workspace does not block this workspace", async () => {
  const state = seeded({ existingWorkspace: "workspace:clone-a" });
  const authority = createWorkAuthority({ state, operationLiveness: assessor("UNKNOWN", "OWNER_OBSERVATION_UNAVAILABLE") });
  const result = await authorize(authority, "workspace:canonical");

  assert.equal(result.allowed, true);
});

test("no persisted operation candidates needs no liveness service", async () => {
  const state = createReferenceState();
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  const authority = createWorkAuthority({ state });
  const result = await authorize(authority);

  assert.equal(result.allowed, true);
});
