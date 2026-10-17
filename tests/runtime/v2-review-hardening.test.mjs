import test from "node:test";
import assert from "node:assert/strict";

import { authorizeCapability } from "../../v2/authority/authority.mjs";
import { createContinuationCapsule, verifyContinuationCapsule } from "../../v2/continuation/capsule.mjs";
import { projectExperience } from "../../v2/experience/projector.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";

const project = {
  schema: "orchestra.project.v2",
  projectId: "prj-review",
  lineageId: "lineage-review",
  workspace: { canonicalRoot: "C:/Projects/Review", vcs: "git" },
  runtime: { pinnedImage: "2.0.0", instructionEpoch: 3 },
  trust: { mode: "trusted" },
};

const work = {
  schema: "orchestra.work-unit.v2",
  workId: "work-review",
  projectId: project.projectId,
  taskId: "task-review",
  generation: 2,
  runtimeImage: "2.0.0",
  instructionEpoch: 3,
  state: "IMPLEMENTING",
  scopeRef: "scope:review",
  directionRef: null,
  candidateRef: null,
  evidenceRefs: [],
  blockers: [],
  continuationRef: "continuation:review",
};

const actor = {
  schema: "orchestra.actor-provenance.v2",
  provider: "codex",
  subjectHash: "sha256:reviewer",
  source: "PROVIDER_FACT",
  observedAt: "2026-10-16T22:00:00.000Z",
};

test("mutation authority is workspace-scoped so separate implementation clones can run in parallel", () => {
  const liveOperations = [{
    operationId: "op-a",
    projectId: project.projectId,
    workId: work.workId,
    generation: work.generation,
    liveness: "LIVE",
    capabilities: ["WORKSPACE_EDIT"],
    workspaceRef: "workspace:clone-a",
  }];

  const separateClone = authorizeCapability({
    project,
    work,
    actor,
    capability: "WORKSPACE_EDIT",
    workspaceRef: "workspace:clone-b",
    expectedGeneration: 2,
    liveOperations,
  });
  const sameClone = authorizeCapability({
    project,
    work,
    actor,
    capability: "WORKSPACE_EDIT",
    workspaceRef: "workspace:clone-a",
    expectedGeneration: 2,
    liveOperations,
  });
  const missingWorkspace = authorizeCapability({
    project,
    work,
    actor,
    capability: "WORKSPACE_EDIT",
    expectedGeneration: 2,
    liveOperations: [],
  });

  assert.equal(separateClone.allowed, true);
  assert.equal(sameClone.allowed, false);
  assert.equal(sameClone.reason, "INCOMPATIBLE_LIVE_OPERATION");
  assert.equal(missingWorkspace.allowed, false);
  assert.equal(missingWorkspace.reason, "MUTATION_WORKSPACE_REQUIRED");
});

test("project registration and rebind retries return current state instead of false conflicts", () => {
  const state = createReferenceState();
  assert.equal(state.projects.register(project).ok, true);

  const rebindCommand = {
    projectId: project.projectId,
    expectedRoot: "C:/Projects/Review",
    newRoot: "C:/Projects/Review-Moved",
  };
  assert.equal(state.projects.rebind(rebindCommand).ok, true);

  const registerReplay = state.projects.register(project);
  const rebindReplay = state.projects.rebind(rebindCommand);

  assert.equal(registerReplay.ok, true);
  assert.equal(registerReplay.replayed, true);
  assert.equal(registerReplay.project.workspace.canonicalRoot, "C:/Projects/Review-Moved");
  assert.equal(rebindReplay.ok, true);
  assert.equal(rebindReplay.replayed, true);
  assert.equal(rebindReplay.project.workspace.canonicalRoot, "C:/Projects/Review-Moved");
});

test("Experience projection rejects normalized variants of private fields", () => {
  const common = {
    category: "DIAGNOSTIC",
    sourceProjectId: project.projectId,
    sourceLineageId: project.lineageId,
    domainCohort: "software-engineering",
    outcome: { recoveryClass: "RECONCILED" },
    projectLineageIds: [project.lineageId, "lineage-b"],
    requestedScope: "GLOBAL_CANDIDATE",
  };

  for (const facts of [
    { failureClass: "OWNER_TERMINATED", source_code: "private code" },
    { failureClass: "OWNER_TERMINATED", "File-Contents": "private bytes" },
    { failureClass: "OWNER_TERMINATED", chain_of_thought: "private reasoning" },
    { failureClass: "OWNER_TERMINATED", session_id: "raw session" },
    { failureClass: "OWNER_TERMINATED", nested: { Transcript: "old chat" } },
  ]) {
    assert.equal(projectExperience({ ...common, facts }).valid, false);
  }

  const safe = projectExperience({
    ...common,
    facts: { failureClass: "OWNER_TERMINATED", retryCount: 0 },
  });
  assert.equal(safe.valid, true);
  assert.equal(safe.experience.generalization.scope, "GLOBAL_CANDIDATE");
});

test("Continuation Capsule rejects non-JSON fact objects whose mutations would evade canonical digest", () => {
  const withDate = createContinuationCapsule({
    work,
    facts: { observedAt: new Date("2026-10-16T22:00:00.000Z") },
  });
  const withMap = createContinuationCapsule({
    work,
    facts: { map: new Map([["key", "value"]]) },
  });

  assert.equal(withDate.valid, false);
  assert.equal(withDate.reason, "CONTINUATION_FACTS_INVALID");
  assert.equal(withMap.valid, false);
  assert.equal(withMap.reason, "CONTINUATION_FACTS_INVALID");
});

test("Continuation Capsule verification rejects unsigned extra top-level fields", () => {
  const created = createContinuationCapsule({ work, facts: { safe: "fact" } });
  assert.equal(created.valid, true);

  const injected = structuredClone(created.capsule);
  injected.transcript = "unsigned old chat";

  const verified = verifyContinuationCapsule(injected);
  assert.equal(verified.valid, false);
  assert.equal(verified.reason, "CONTINUATION_SCHEMA_INVALID");
});
