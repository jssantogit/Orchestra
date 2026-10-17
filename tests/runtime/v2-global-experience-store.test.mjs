import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPERIENCE_CATEGORIES,
  toCrossProjectExperience,
  validateExperienceRecord,
} from "../../v2/experience/contracts.mjs";
import { projectExperience } from "../../v2/experience/projector.mjs";

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
  const projected = projectExperience(baseInput);
  assert.equal(projected.valid, true);

  const tampered = {
    ...projected.experience,
    privacy: {
      ...projected.experience.privacy,
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
