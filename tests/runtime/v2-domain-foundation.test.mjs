import test from "node:test";
import assert from "node:assert/strict";

import {
  validateActorProvenanceV2,
  validateExperienceV2,
  validateOperationV2,
  validateProjectV2,
  validateRuntimeImageRefV2,
  validateWorkUnitV2,
} from "../../v2/domain/contracts.mjs";
import {
  authorizeAttach,
  authorizeCapability,
} from "../../v2/authority/authority.mjs";
import {
  classifyPersistedOperation,
} from "../../v2/reconciliation/liveness.mjs";
import {
  projectExperience,
} from "../../v2/experience/projector.mjs";

const project = {
  schema: "orchestra.project.v2",
  projectId: "prj-tsuzuki",
  lineageId: "lineage-tsuzuki",
  workspace: { canonicalRoot: "C:/Projects/Tsuzuki", vcs: "git" },
  runtime: { pinnedImage: "2.0.0", instructionEpoch: 27 },
  trust: { mode: "trusted" },
};

const actor = {
  schema: "orchestra.actor-provenance.v2",
  provider: "codex",
  subjectHash: "sha256:actor-a",
  source: "PROVIDER_FACT",
  observedAt: "2026-10-16T17:00:00.000Z",
};

const work = {
  schema: "orchestra.work-unit.v2",
  workId: "work-f7",
  projectId: project.projectId,
  taskId: "tsuzuki-f7",
  generation: 18,
  runtimeImage: "2.0.0",
  instructionEpoch: 27,
  state: "IMPLEMENTING",
  scopeRef: "scope:f7",
  directionRef: "direction:f7",
  candidateRef: null,
  evidenceRefs: [],
  blockers: [],
  continuationRef: "continuation:f7",
};

test("v2 canonical contracts accept provider-neutral project/work/operation facts", () => {
  assert.equal(validateProjectV2(project).valid, true);
  assert.equal(validateActorProvenanceV2(actor).valid, true);
  assert.equal(validateWorkUnitV2(work).valid, true);
  assert.equal(validateRuntimeImageRefV2({
    schema: "orchestra.runtime-image-ref.v2",
    version: "2.0.0",
    contentId: "sha256:image",
    contractVersion: "2",
    instructionEpochBase: 27,
  }).valid, true);
  assert.equal(validateOperationV2({
    schema: "orchestra.operation.v2",
    operationId: "op-1",
    projectId: project.projectId,
    workId: work.workId,
    generation: work.generation,
    kind: "IMPLEMENTATION_MEMBER",
    actorRef: "actor:sha256:actor-a",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-16T17:00:01.000Z",
    heartbeatAt: "2026-10-16T17:00:02.000Z",
    deadlineAt: "2026-10-16T17:10:00.000Z",
    runtimeOwnerRef: "process:123:token-a",
    workspaceRef: "workspace:impl-a",
    resultRef: null,
  }).valid, true);
  assert.equal(validateExperienceV2({
    schema: "orchestra.experience.v2",
    experienceId: "exp-1",
    category: "LIFECYCLE_FAILURE",
    facts: { failureClass: "OWNER_TERMINATED" },
    outcome: { recoveryClass: "RECONCILED" },
    generalization: { scope: "GLOBAL_CANDIDATE", projectLineageCount: 2 },
    privacy: { projectionVersion: "1", containsRawProjectContent: false },
  }).valid, true);
});

test("v2 Actor Provenance rejects raw provider session identity and caller-inferred identity", () => {
  assert.equal(validateActorProvenanceV2({ ...actor, sessionId: "raw-session" }).valid, false);
  assert.equal(validateActorProvenanceV2({ ...actor, source: "ENV_INFERRED" }).valid, false);
});

test("fresh factual actor can attach without historical chat ownership", () => {
  const decision = authorizeAttach({
    project,
    work,
    actor,
    observedInstructionEpoch: 27,
    liveOperations: [],
  });
  assert.deepEqual(decision, { allowed: true, reason: null, generation: 18 });
});

test("stale instruction epoch is explicit rather than becoming an ownership mismatch", () => {
  const decision = authorizeAttach({
    project,
    work,
    actor,
    observedInstructionEpoch: 26,
    liveOperations: [],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "SESSION_RUNTIME_STALE");
  assert.equal(decision.currentInstructionEpoch, 27);
  assert.equal(decision.continuationAvailable, true);
});

test("generation fences stale mutation without binding CONTROL to a chat", () => {
  const decision = authorizeCapability({
    project,
    work,
    actor,
    capability: "WORKSPACE_EDIT",
    expectedGeneration: 17,
    liveOperations: [],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "STALE_GENERATION");
});

test("real live incompatible mutation blocks another writer", () => {
  const decision = authorizeCapability({
    project,
    work,
    actor,
    capability: "WORKSPACE_EDIT",
    expectedGeneration: 18,
    liveOperations: [{
      projectId: project.projectId,
      workId: work.workId,
      generation: 18,
      capabilities: ["WORKSPACE_EDIT"],
      liveness: "LIVE",
      actorRef: "actor:someone-else",
    }],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "INCOMPATIBLE_LIVE_OPERATION");
});

test("persisted RUNNING alone is never factual LIVE", () => {
  const classified = classifyPersistedOperation({
    operation: {
      workflowState: "RUNNING",
      liveness: "LIVE",
      heartbeatAt: null,
      deadlineAt: null,
      runtimeOwnerRef: null,
    },
    ownerProof: null,
    heartbeatFresh: false,
  });
  assert.notEqual(classified.liveness, "LIVE");
  assert.equal(classified.liveness, "UNKNOWN");
});

test("Tsuzuki F7 legacy orphan fixture cannot become LIVE from RUNNING enum", () => {
  const classified = classifyPersistedOperation({
    operation: {
      workflowState: "RUNNING",
      createdAt: "2026-10-16T15:27:58.440Z",
      updatedAt: "2026-10-16T15:27:58.446Z",
      memberArtifactIds: [],
      compositeArtifactId: null,
    },
    ownerProof: null,
    heartbeatFresh: false,
    survivingWorkspaceCount: 2,
  });
  assert.equal(classified.liveness, "UNKNOWN");
  assert.equal(classified.reason, "LIVENESS_NOT_PROVEN");
});

test("cross-project operation facts fail closed", () => {
  const decision = authorizeCapability({
    project,
    work,
    actor,
    capability: "WORKSPACE_EDIT",
    expectedGeneration: 18,
    liveOperations: [{
      projectId: "prj-other",
      workId: work.workId,
      generation: 18,
      capabilities: ["WORKSPACE_EDIT"],
      liveness: "LIVE",
    }],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "CROSS_PROJECT_OPERATION");
});

test("Experience projection rejects raw project content and cannot globalize one lineage", () => {
  const rejected = projectExperience({
    category: "DIAGNOSTIC",
    sourceProjectId: project.projectId,
    sourceLineageId: project.lineageId,
    domainCohort: "software-engineering",
    facts: {
      failureClass: "RG_NO_MATCH",
      sourceCode: "private bytes",
      prompt: "private prompt",
      fileContents: "secret",
    },
    outcome: { recoveryClass: "CONTINUE" },
    projectLineageIds: [project.lineageId],
    requestedScope: "GLOBAL_CANDIDATE",
  });
  assert.equal(rejected.valid, false);

  const result = projectExperience({
    category: "DIAGNOSTIC",
    sourceProjectId: project.projectId,
    sourceLineageId: project.lineageId,
    domainCohort: "software-engineering",
    facts: { failureClass: "RG_NO_MATCH" },
    outcome: { recoveryClass: "CONTINUE" },
    projectLineageIds: [project.lineageId, project.lineageId],
    requestedScope: "GLOBAL_CANDIDATE",
  });

  assert.equal(result.valid, true);
  assert.equal(result.experience.privacy.containsRawProjectContent, false);
  assert.equal(result.experience.generalization.scope, "PROJECT");
  assert.equal(result.experience.generalization.projectLineageCount, 1);
});
