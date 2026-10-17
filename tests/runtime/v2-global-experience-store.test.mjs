import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPERIENCE_CATEGORIES,
  toCrossProjectExperience,
  validateExperienceRecord,
} from "../../v2/experience/contracts.mjs";
import { projectExperience } from "../../v2/experience/projector.mjs";
import { createExperienceQuery } from "../../v2/experience/query.mjs";

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
  outcome: {
    terminalOutcome: "RECOVERED",
    success: true,
  },
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
      return selected.slice(0, limit + 1).map(structuredClone);
    },
  });
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
  assert.equal(valid.experience.category, "DIAGNOSTIC");
  assert.equal(valid.experience.source.projectId, "prj-tsuzuki");
  assert.equal(valid.experience.source.lineageId, "lineage-tsuzuki");
  assert.equal(valid.experience.source.workId, "work-f7");
  assert.equal(valid.experience.source.operationId, "op-f7-1");
  assert.equal(valid.experience.domainCohort, "software-engineering");
  assert.equal(valid.experience.privacy.projectionVersion, "1");
  assert.equal(valid.experience.privacy.containsRawProjectContent, false);

  const invalid = projectExperience({ ...baseInput, category: "SIXTH_CLASS" });
  assert.equal(invalid.valid, false);
});

test("Experience contract rejects raw or arbitrary project content instead of silently persisting it", () => {
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
    const result = projectExperience({ ...baseInput, facts });
    assert.equal(result.valid, false, `unexpectedly accepted ${JSON.stringify(facts)}`);
  }
});

test("Experience contract accepts only normalized learning dimensions", () => {
  const result = projectExperience({
    ...baseInput,
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
    outcome: {
      terminalOutcome: "SUCCEEDED",
      success: true,
    },
  });

  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(validateExperienceRecord(result.experience).valid, true);
});

test("containsRawProjectContent can never be true in a valid record", () => {
  const projectedRecord = projectExperience(baseInput);
  assert.equal(projectedRecord.valid, true);

  const tampered = {
    ...projectedRecord.experience,
    privacy: {
      ...projectedRecord.experience.privacy,
      containsRawProjectContent: true,
    },
  };
  assert.equal(validateExperienceRecord(tampered).valid, false);
});

test("one lineage cannot claim cross-project eligibility", () => {
  const result = projectExperience({
    ...baseInput,
    requestedScope: "GLOBAL_CANDIDATE",
    projectLineageIds: ["lineage-tsuzuki", "lineage-tsuzuki"],
  });

  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.experience.generalization.scope, "PROJECT");
  assert.equal(result.experience.generalization.projectLineageCount, 1);
});

test("cross-project payload omits source Project and originating private audit refs by default", () => {
  const result = projectExperience({
    ...baseInput,
    projectLineageIds: ["lineage-tsuzuki", "lineage-other"],
    requestedScope: "GLOBAL_CANDIDATE",
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const crossProject = toCrossProjectExperience(result.experience);
  assert.equal(crossProject.sourceProjectId, undefined);
  assert.equal(crossProject.workId, undefined);
  assert.equal(crossProject.operationId, undefined);
  assert.equal(crossProject.source?.projectId, undefined);
  assert.equal(crossProject.source?.workId, undefined);
  assert.equal(crossProject.source?.operationId, undefined);
  assert.equal(crossProject.source?.lineageId, "lineage-tsuzuki");
  assert.equal(crossProject.domainCohort, "software-engineering");
});

test("bounded cross-project query supports the approved sanitized dimensions only", () => {
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
    facts: {
      providerFamily: "antigravity",
      osFamily: "linux",
      runtimeVersion: "2.7.0",
      routeClass: "DIRECT_WORK",
      latencyBucket: "LOW",
    },
    outcome: { terminalOutcome: "SUCCEEDED", success: true },
  });
  const query = createExperienceQuery({ persistence: fakeQueryPersistence([other, matching]) });

  const result = query.crossProject({
    filters: {
      category: "DIAGNOSTIC",
      providerFamily: "codex",
      domainCohort: "software-engineering",
      failureClass: "OWNER_TERMINATED",
      recoveryClass: "RECONCILED",
      terminalOutcome: "RECOVERED",
      eligibilityScope: "GLOBAL_CANDIDATE",
      minProjectLineageCount: 2,
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].experienceId, matching.experienceId);
  assert.equal(result.items[0].source.projectId, undefined);
  assert.equal(result.items[0].source.workId, undefined);
  assert.equal(result.items[0].source.operationId, undefined);
  assert.equal(result.items[0].facts.providerFamily, "codex");
});

test("project-private query resolves provenance only when explicitly scoped to that Project", () => {
  const a = projected();
  const b = projected({
    sourceProjectId: "prj-b",
    sourceLineageId: "lineage-b",
    workId: "work-b",
    operationId: "op-b",
    projectLineageIds: ["lineage-b"],
  });
  const query = createExperienceQuery({ persistence: fakeQueryPersistence([a, b]) });

  assert.throws(
    () => query.projectPrivate({}),
    (error) => error?.code === "ORCHESTRA_EXPERIENCE_QUERY_INVALID",
  );
  const result = query.projectPrivate({ projectId: "prj-tsuzuki" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source.projectId, "prj-tsuzuki");
  assert.equal(result.items[0].source.workId, "work-f7");
  assert.equal(result.items[0].source.operationId, "op-f7-1");
});

test("Experience query pagination and ordering are deterministic", () => {
  const records = [
    projected({ category: "EXECUTION", operationId: "op-c" }),
    projected({ category: "EXECUTION", operationId: "op-a" }),
    projected({ category: "EXECUTION", operationId: "op-b" }),
  ];
  const query = createExperienceQuery({ persistence: fakeQueryPersistence(records) });
  const expected = [...records].sort((left, right) => left.experienceId.localeCompare(right.experienceId));

  const first = query.crossProject({ filters: { category: "EXECUTION" }, limit: 1 });
  assert.deepEqual(first.items.map((record) => record.experienceId), [expected[0].experienceId]);
  assert.equal(first.nextCursor, expected[0].experienceId);

  const second = query.crossProject({ filters: { category: "EXECUTION" }, limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((record) => record.experienceId), [expected[1].experienceId]);
  assert.equal(second.nextCursor, expected[1].experienceId);
});

test("unknown Experience query filter fails closed before persistence execution", () => {
  let called = false;
  const query = createExperienceQuery({
    persistence: {
      query() {
        called = true;
        return [];
      },
    },
  });

  assert.throws(
    () => query.crossProject({ filters: { arbitrarySql: "DROP TABLE projects" } }),
    (error) => error?.code === "ORCHESTRA_EXPERIENCE_QUERY_INVALID",
  );
  assert.equal(called, false);
});
