import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPERIENCE_CATEGORIES,
  toCrossProjectExperience,
  validateExperienceRecord,
} from "../../v2/experience/contracts.mjs";
import { projectExperience } from "../../v2/experience/projector.mjs";
import { createExperienceQuery } from "../../v2/experience/query.mjs";
import { createExperienceRecorders } from "../../v2/experience/recorders.mjs";

const baseInput = {
  category: "DIAGNOSTIC",
  sourceProjectId: "prj-tsuzuki",
  sourceLineageId: "lineage-tsuzuki",
  workId: "work-f7",
  operationId: "op-f7-1",
  domainCohort: "software-engineering",
  facts: {
    failureClass: "OWNER_TERMINATED",
    recoveryClass: "RECONCILED",
    providerFamily: "codex",
    osFamily: "windows",
    runtimeVersion: "2.7.0",
    retryCount: 1,
    latencyBucket: "MEDIUM",
  },
  outcome: { terminalOutcome: "RECOVERED", success: true },
  projectLineageIds: ["lineage-tsuzuki"],
  requestedScope: "PROJECT",
  projectionVersion: "1",
};

function projected(overrides = {}) {
  const result = projectExperience({ ...baseInput, ...overrides });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  return result.experience;
}

function fakeQueryPersistence(records) {
  const ordered = [...records].sort((left, right) => left.experienceId.localeCompare(right.experienceId));
  return Object.freeze({
    query({ filters, projectId = null, afterId = null, limit }) {
      let selected = ordered;
      if (projectId !== null) selected = selected.filter((record) => record.source.projectId === projectId);
      if (afterId !== null) selected = selected.filter((record) => record.experienceId > afterId);
      if (filters.category !== undefined) selected = selected.filter((record) => record.category === filters.category);
      if (filters.providerFamily !== undefined) selected = selected.filter((record) => record.facts.providerFamily === filters.providerFamily);
      if (filters.domainCohort !== undefined) selected = selected.filter((record) => record.domainCohort === filters.domainCohort);
      if (filters.failureClass !== undefined) selected = selected.filter((record) => (record.facts.failureClass ?? record.outcome.failureClass) === filters.failureClass);
      if (filters.recoveryClass !== undefined) selected = selected.filter((record) => (record.facts.recoveryClass ?? record.outcome.recoveryClass) === filters.recoveryClass);
      if (filters.terminalOutcome !== undefined) selected = selected.filter((record) => record.outcome.terminalOutcome === filters.terminalOutcome);
      if (filters.eligibilityScope !== undefined) selected = selected.filter((record) => record.generalization.scope === filters.eligibilityScope);
      if (filters.minProjectLineageCount !== undefined) selected = selected.filter((record) => record.generalization.projectLineageCount >= filters.minProjectLineageCount);
      return selected.slice(0, limit + 1).map((record) => structuredClone(record));
    },
  });
}

function capturePersistence({ fail = false } = {}) {
  const records = new Map();
  return {
    records,
    persistence: {
      put(record) {
        if (fail) throw new Error("experience unavailable");
        const existing = records.get(record.experienceId);
        if (existing) return { ok: true, experience: existing, replayed: true, digest: "sha256:replay" };
        const clone = structuredClone(record);
        records.set(record.experienceId, clone);
        return { ok: true, experience: clone, replayed: false, digest: "sha256:new" };
      },
      inspect(experienceId) { return records.get(experienceId) ?? null; },
      list() { return [...records.values()].map((record) => structuredClone(record)); },
    },
  };
}

function recorderProject() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-tsuzuki",
    lineageId: "lineage-tsuzuki",
    workspace: { canonicalRoot: "C:/Projects/Tsuzuki", vcs: "git" },
    runtime: { pinnedImage: "image-current", instructionEpoch: 27 },
    trust: { mode: "trusted" },
  };
}

function recorderOperation(overrides = {}) {
  return {
    operationId: "op-f7-1",
    projectId: "prj-tsuzuki",
    workId: "work-f7",
    kind: "DIRECT_MUTATION",
    workflowState: "SUCCEEDED",
    liveness: "TERMINAL",
    ...overrides,
  };
}

test("Experience v1 closes the category set to exactly five approved classes", () => {
  assert.deepEqual([...EXPERIENCE_CATEGORIES], [
    "DIAGNOSTIC",
    "EXECUTION",
    "PROVIDER_TOOL_FACT",
    "PERFORMANCE",
    "COUNTEREXAMPLE",
  ]);
  const valid = projectExperience(baseInput);
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  assert.equal(valid.experience.schema, "orchestra.experience.v2");
  assert.equal(valid.experience.version, 1);
  assert.equal(valid.experience.source.projectId, "prj-tsuzuki");
  assert.equal(valid.experience.privacy.containsRawProjectContent, false);
  assert.equal(projectExperience({ ...baseInput, category: "SIXTH_CLASS" }).valid, false);
});

test("Experience contract rejects raw or arbitrary project content instead of redacting on read", () => {
  for (const facts of [
    { ...baseInput.facts, sourceCode: "private bytes" },
    { ...baseInput.facts, diff: "@@ -1 +1 @@ secret" },
    { ...baseInput.facts, prompt: "private prompt" },
    { ...baseInput.facts, transcript: "private transcript" },
    { ...baseInput.facts, token: "sk-private" },
    { ...baseInput.facts, artifactBytes: "010203" },
    { ...baseInput.facts, hiddenReasoning: "private reasoning" },
    { ...baseInput.facts, nested: { prompt: "still private" } },
  ]) {
    assert.equal(projectExperience({ ...baseInput, facts }).valid, false, JSON.stringify(facts));
  }
});

test("Experience accepts normalized learning dimensions and rejects raw-content privacy claims", () => {
  const record = projected({
    category: "PERFORMANCE",
    facts: {
      providerFamily: "antigravity",
      osFamily: "linux",
      runtimeVersion: "2.7.0",
      operationClass: "IMPLEMENTATION",
      routeClass: "DIRECT_WORK",
      latencyBucket: "LOW",
      turnCount: 3,
      retryCount: 0,
    },
    outcome: { terminalOutcome: "SUCCEEDED", success: true },
  });
  assert.equal(validateExperienceRecord(record).valid, true);
  assert.equal(validateExperienceRecord({
    ...record,
    privacy: { ...record.privacy, containsRawProjectContent: true },
  }).valid, false);
});

test("one lineage cannot claim independent-lineage eligibility", () => {
  const record = projected({
    requestedScope: "GLOBAL_CANDIDATE",
    projectLineageIds: ["lineage-tsuzuki", "lineage-tsuzuki"],
  });
  assert.equal(record.generalization.scope, "PROJECT");
  assert.equal(record.generalization.projectLineageCount, 1);
});

test("cross-project payload omits source Project and private audit refs", () => {
  const record = projected({
    projectLineageIds: ["lineage-tsuzuki", "lineage-other"],
    requestedScope: "GLOBAL_CANDIDATE",
  });
  const crossProject = toCrossProjectExperience(record);
  assert.equal(crossProject.source.projectId, undefined);
  assert.equal(crossProject.source.workId, undefined);
  assert.equal(crossProject.source.operationId, undefined);
  assert.equal(crossProject.source.lineageId, "lineage-tsuzuki");
});

test("bounded cross-project query supports only approved sanitized dimensions", () => {
  const matching = projected({
    projectLineageIds: ["lineage-tsuzuki", "lineage-other"],
    requestedScope: "GLOBAL_CANDIDATE",
  });
  const other = projected({
    category: "PERFORMANCE",
    sourceProjectId: "prj-other",
    sourceLineageId: "lineage-other",
    workId: "work-other",
    operationId: "op-other",
    domainCohort: "documentation",
    facts: { providerFamily: "antigravity", osFamily: "linux", runtimeVersion: "2.7.0", latencyBucket: "LOW" },
    outcome: { terminalOutcome: "SUCCEEDED", success: true },
  });
  const query = createExperienceQuery({ persistence: fakeQueryPersistence([other, matching]) });
  const result = query.crossProject({ filters: {
    category: "DIAGNOSTIC",
    providerFamily: "codex",
    domainCohort: "software-engineering",
    failureClass: "OWNER_TERMINATED",
    recoveryClass: "RECONCILED",
    terminalOutcome: "RECOVERED",
    eligibilityScope: "GLOBAL_CANDIDATE",
    minProjectLineageCount: 2,
  } });
  assert.deepEqual(result.items.map((record) => record.experienceId), [matching.experienceId]);
  assert.equal(result.items[0].source.projectId, undefined);
});

test("project-private query requires explicit Project scope and cannot cross it", () => {
  const a = projected();
  const b = projected({
    sourceProjectId: "prj-b",
    sourceLineageId: "lineage-b",
    workId: "work-b",
    operationId: "op-b",
    projectLineageIds: ["lineage-b"],
  });
  const query = createExperienceQuery({ persistence: fakeQueryPersistence([a, b]) });
  assert.throws(() => query.projectPrivate({}), (error) => error?.code === "ORCHESTRA_EXPERIENCE_QUERY_INVALID");
  const result = query.projectPrivate({ projectId: "prj-tsuzuki" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source.projectId, "prj-tsuzuki");
  assert.equal(result.items[0].source.workId, "work-f7");
});

test("Experience query ordering and pagination are deterministic", () => {
  const records = [
    projected({ category: "EXECUTION", operationId: "op-c" }),
    projected({ category: "EXECUTION", operationId: "op-a" }),
    projected({ category: "EXECUTION", operationId: "op-b" }),
  ];
  const expected = [...records].sort((left, right) => left.experienceId.localeCompare(right.experienceId));
  const query = createExperienceQuery({ persistence: fakeQueryPersistence(records) });
  const first = query.crossProject({ filters: { category: "EXECUTION" }, limit: 1 });
  const second = query.crossProject({ filters: { category: "EXECUTION" }, limit: 1, cursor: first.nextCursor });
  assert.deepEqual(first.items.map((record) => record.experienceId), [expected[0].experienceId]);
  assert.deepEqual(second.items.map((record) => record.experienceId), [expected[1].experienceId]);
});

test("unknown Experience query filter fails closed before persistence", () => {
  let called = false;
  const query = createExperienceQuery({ persistence: { query() { called = true; return []; } } });
  assert.throws(
    () => query.crossProject({ filters: { arbitrarySql: "DROP TABLE projects" } }),
    (error) => error?.code === "ORCHESTRA_EXPERIENCE_QUERY_INVALID",
  );
  assert.equal(called, false);
});

test("stale recovery emits DIAGNOSTIC facts without workspace source content", async () => {
  const captured = capturePersistence();
  const recorders = createExperienceRecorders({ persistence: captured.persistence });
  const result = await recorders.recordRecovery({
    project: recorderProject(),
    operation: recorderOperation({ workflowState: "ABORTED" }),
    cleanupStatus: "CLEANED",
    recoveryClass: "RECONCILED",
    failureClass: "OWNER_TERMINATED",
    rawWorkspacePath: "C:/Users/private/project/.orchestra/worktree",
  });
  assert.equal(result.ok, true);
  const [record] = captured.records.values();
  assert.equal(record.category, "DIAGNOSTIC");
  assert.equal(record.facts.failureClass, "OWNER_TERMINATED");
  assert.equal(record.facts.recoveryClass, "RECONCILED");
  assert.equal(JSON.stringify(record).includes("C:/Users/private"), false);
});

test("provider capability and terminal recorders emit sanitized tool/execution/performance facts", async () => {
  const captured = capturePersistence();
  const recorders = createExperienceRecorders({ persistence: captured.persistence });
  const project = recorderProject();
  const operation = recorderOperation();
  assert.equal((await recorders.recordProviderCapability({
    project,
    workId: operation.workId,
    operationId: operation.operationId,
    providerFamily: "codex",
    capabilityClass: "WORKSPACE_EDIT",
    toolClass: "MUTATION",
    rawProviderPayload: { session_id: "private-session", prompt: "secret" },
  })).ok, true);
  assert.equal((await recorders.recordProviderTerminal({
    project,
    operation,
    providerFamily: "codex",
    workflowState: "SUCCEEDED",
    rawProviderPayload: { tool_response: "private source output" },
  })).ok, true);
  assert.deepEqual([...captured.records.values()].map((record) => record.category).sort(), [
    "EXECUTION", "PERFORMANCE", "PROVIDER_TOOL_FACT",
  ]);
  const serialized = JSON.stringify([...captured.records.values()]);
  assert.equal(serialized.includes("private-session"), false);
  assert.equal(serialized.includes("private source output"), false);
});

test("runtime rollback and failure emit bounded COUNTEREXAMPLE/DIAGNOSTIC records", async () => {
  const captured = capturePersistence();
  const recorders = createExperienceRecorders({ persistence: captured.persistence });
  const project = recorderProject();
  assert.equal((await recorders.recordRuntimeChange({ project, action: "ROLLBACK" })).ok, true);
  assert.equal((await recorders.recordRuntimeFailure({ project, failureClass: "RUNTIME_IMAGE_INCOMPATIBLE" })).ok, true);
  const records = [...captured.records.values()];
  assert.equal(records.some((record) => record.category === "COUNTEREXAMPLE"), true);
  assert.equal(records.some((record) => record.category === "DIAGNOSTIC"), true);
  assert.equal(records.every((record) => record.source.workId === null && record.source.operationId === null), true);
});

test("duplicate terminal events converge to identical Experience identities", async () => {
  const captured = capturePersistence();
  const recorders = createExperienceRecorders({ persistence: captured.persistence });
  const command = {
    project: recorderProject(),
    operation: recorderOperation(),
    providerFamily: "antigravity",
    workflowState: "FAILED",
  };
  const first = await recorders.recordProviderTerminal(command);
  const second = await recorders.recordProviderTerminal(command);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(captured.records.size, 2);
  assert.deepEqual(first.experienceIds, second.experienceIds);
});

test("Experience recorder failure is a bounded non-authoritative learning failure", async () => {
  const captured = capturePersistence({ fail: true });
  const recorders = createExperienceRecorders({ persistence: captured.persistence });
  assert.deepEqual(await recorders.recordProviderTerminal({
    project: recorderProject(),
    operation: recorderOperation(),
    providerFamily: "codex",
    workflowState: "SUCCEEDED",
  }), { ok: false, reason: "EXPERIENCE_RECORDING_FAILED" });
});
