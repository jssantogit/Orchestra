import test from "node:test";
import assert from "node:assert/strict";

import { LOGICAL_ROLES } from "../../core/domain/logical-role.mjs";
import { escalateTask } from "../../core/routing/escalation.mjs";

const boundedTask = Object.freeze({
  breadth: "BOUNDED",
  diagnosisState: "KNOWN",
  role: "IMPLEMENTATION",
  criticality: "NORMAL",
  sideEffectClass: "WORKSPACE_MUTATION",
});

test("failed implementation with unresolved diagnosis escalates to investigator", () => {
  const result = escalateTask({
    task: boundedTask,
    currentRole: LOGICAL_ROLES.IMPLEMENTER,
    result: { status: "FAILED", diagnosisState: "UNKNOWN" },
  });

  assert.deepEqual(result, {
    nextRole: LOGICAL_ROLES.INVESTIGATOR,
    intensity: "high",
    terminal: false,
    reason: "IMPLEMENTATION_NEEDS_DIAGNOSIS",
  });
});

test("investigation escalates through provider-neutral high xhigh max ladder", () => {
  const high = escalateTask({
    task: boundedTask,
    currentRole: LOGICAL_ROLES.INVESTIGATOR,
    result: { status: "INCONCLUSIVE", currentIntensity: "high" },
  });
  assert.deepEqual(high, {
    nextRole: LOGICAL_ROLES.INVESTIGATOR,
    intensity: "xhigh",
    terminal: false,
    reason: "DEEPER_INVESTIGATION_REQUIRED",
  });

  const xhigh = escalateTask({
    task: boundedTask,
    currentRole: LOGICAL_ROLES.INVESTIGATOR,
    result: { status: "INCONCLUSIVE", currentIntensity: "xhigh" },
  });
  assert.equal(xhigh.nextRole, LOGICAL_ROLES.INVESTIGATOR);
  assert.equal(xhigh.intensity, "max");
  assert.equal(xhigh.terminal, false);

  const max = escalateTask({
    task: boundedTask,
    currentRole: LOGICAL_ROLES.INVESTIGATOR,
    result: { status: "INCONCLUSIVE", currentIntensity: "max" },
  });
  assert.deepEqual(max, {
    nextRole: LOGICAL_ROLES.INVESTIGATOR,
    intensity: "max",
    terminal: true,
    reason: "INVESTIGATION_CEILING_REACHED",
  });
});

test("investigation ceiling never automatically selects manual escalation", () => {
  const result = escalateTask({
    task: boundedTask,
    currentRole: LOGICAL_ROLES.INVESTIGATOR,
    result: { status: "FAILED", currentIntensity: "max" },
  });

  assert.notEqual(result.nextRole, LOGICAL_ROLES.MANUAL_ESCALATION);
  assert.equal(result.terminal, true);
});

test("dangerous external side effect stops automatic routing at a manual gate", () => {
  const result = escalateTask({
    task: { ...boundedTask, criticality: "CRITICAL", sideEffectClass: "DESTRUCTIVE_EXTERNAL" },
    currentRole: LOGICAL_ROLES.IMPLEMENTER,
    result: { status: "READY" },
  });

  assert.deepEqual(result, {
    nextRole: LOGICAL_ROLES.MANUAL_ESCALATION,
    intensity: "manual",
    terminal: true,
    reason: "DANGEROUS_SIDE_EFFECT_MANUAL_GATE",
  });
});

test("critical acceptance boundary routes to independent critical reviewer", () => {
  const result = escalateTask({
    task: { ...boundedTask, role: "ACCEPTANCE", criticality: "CRITICAL", sideEffectClass: "READ_ONLY" },
    currentRole: LOGICAL_ROLES.CONTROL,
    result: { status: "EVIDENCE_READY" },
  });

  assert.deepEqual(result, {
    nextRole: LOGICAL_ROLES.CRITICAL_REVIEWER,
    intensity: "specialist",
    terminal: false,
    reason: "CRITICAL_ACCEPTANCE_REVIEW_REQUIRED",
  });
});

test("explicit manual request may select manual escalation without provider model semantics", () => {
  const result = escalateTask({
    task: boundedTask,
    currentRole: LOGICAL_ROLES.CONTROL,
    result: { status: "BLOCKED", manualRequested: true },
  });

  assert.equal(result.nextRole, LOGICAL_ROLES.MANUAL_ESCALATION);
  assert.equal(result.terminal, true);
  assert.doesNotMatch(JSON.stringify(result), /gpt|gemini|luna|sol-|flash-|astra-manual/i);
});
