import test from "node:test";
import assert from "node:assert/strict";

import { LOGICAL_ROLES } from "../../core/domain/logical-role.mjs";
import { EXECUTION_MODES } from "../../core/workflow/direct-work-policy.mjs";
import { classifyTask } from "../../core/routing/task-classification.mjs";

const fixtures = [
  {
    name: "tiny factual task",
    task: {
      breadth: "TINY",
      diagnosisState: "KNOWN",
      role: "IMPLEMENTATION",
      criticality: "LOW",
      sideEffectClass: "WORKSPACE_MUTATION",
    },
    expected: {
      logicalRole: LOGICAL_ROLES.IMPLEMENTER,
      intensity: "simple",
      directWorkMode: EXECUTION_MODES.DIRECT_WORK,
    },
  },
  {
    name: "moderate bounded bugfix",
    task: {
      breadth: "BOUNDED",
      diagnosisState: "KNOWN",
      role: "IMPLEMENTATION",
      criticality: "NORMAL",
      sideEffectClass: "WORKSPACE_MUTATION",
    },
    expected: {
      logicalRole: LOGICAL_ROLES.IMPLEMENTER,
      intensity: "standard",
      directWorkMode: EXECUTION_MODES.DIRECT_WORK,
    },
  },
  {
    name: "dangerous external side effect",
    task: {
      breadth: "BOUNDED",
      diagnosisState: "KNOWN",
      role: "IMPLEMENTATION",
      criticality: "CRITICAL",
      sideEffectClass: "DESTRUCTIVE_EXTERNAL",
    },
    expected: {
      logicalRole: LOGICAL_ROLES.MANUAL_ESCALATION,
      intensity: "manual",
      directWorkMode: EXECUTION_MODES.ORCHESTRATED_WORK,
    },
  },
  {
    name: "low-confidence investigation",
    task: {
      breadth: "BOUNDED",
      diagnosisState: "LOW_CONFIDENCE",
      role: "IMPLEMENTATION",
      criticality: "NORMAL",
      sideEffectClass: "READ_ONLY",
    },
    expected: {
      logicalRole: LOGICAL_ROLES.INVESTIGATOR,
      intensity: "high",
      directWorkMode: EXECUTION_MODES.GUIDED_WORK,
    },
  },
  {
    name: "critical acceptance boundary",
    task: {
      breadth: "BOUNDED",
      diagnosisState: "KNOWN",
      role: "ACCEPTANCE",
      criticality: "CRITICAL",
      sideEffectClass: "READ_ONLY",
    },
    expected: {
      logicalRole: LOGICAL_ROLES.CRITICAL_REVIEWER,
      intensity: "specialist",
      directWorkMode: EXECUTION_MODES.GUIDED_WORK,
    },
  },
];

for (const fixture of fixtures) {
  test(`classifies ${fixture.name} without provider semantics`, () => {
    const result = classifyTask(fixture.task);
    assert.equal(result.logicalRole, fixture.expected.logicalRole);
    assert.equal(result.intensity, fixture.expected.intensity);
    assert.equal(result.directWorkAssessment.mode, fixture.expected.directWorkMode);
    assert.ok(Array.isArray(result.reasons));
    assert.ok(result.reasons.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /gpt|gemini|luna|sol-|flash-|astra-manual/i);
  });
}

test("unknown diagnosis routes to investigation rather than a giant implementer", () => {
  const result = classifyTask({
    breadth: "BROAD",
    diagnosisState: "UNKNOWN",
    role: "IMPLEMENTATION",
    criticality: "MAJOR",
    sideEffectClass: "WORKSPACE_MUTATION",
  });

  assert.equal(result.logicalRole, LOGICAL_ROLES.INVESTIGATOR);
  assert.equal(result.intensity, "high");
  assert.equal(result.directWorkAssessment.mode, EXECUTION_MODES.GUIDED_WORK);
  assert.ok(result.reasons.includes("DIAGNOSIS_UNRESOLVED"));
});

test("bounded implementation remains a Direct Work candidate", () => {
  const result = classifyTask({
    breadth: "BOUNDED",
    diagnosisState: "KNOWN",
    role: "IMPLEMENTATION",
    criticality: "NORMAL",
    sideEffectClass: "WORKSPACE_MUTATION",
  });

  assert.equal(result.logicalRole, LOGICAL_ROLES.IMPLEMENTER);
  assert.equal(result.directWorkAssessment.mode, EXECUTION_MODES.DIRECT_WORK);
});

test("classification is provider-invariant and ignores concrete model hints", () => {
  const baseTask = {
    breadth: "BOUNDED",
    diagnosisState: "KNOWN",
    role: "IMPLEMENTATION",
    criticality: "NORMAL",
    sideEffectClass: "WORKSPACE_MUTATION",
  };
  const base = classifyTask(baseTask);
  const hinted = classifyTask({ ...baseTask, provider: "codex", model: "gpt-999", profile: "flash-impossible" });
  assert.deepEqual(hinted, base);
});
