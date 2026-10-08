// TDD RED: these contracts intentionally precede the Direct Work implementation.
import test from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_MODES,
  selectExecutionMode,
} from "../../core/workflow/direct-work-policy.mjs";
import {
  DIRECT_WORK_STATES,
  transitionDirectWork,
} from "../../core/workflow/direct-work-state.mjs";

const boundedTask = Object.freeze({
  bounded: true,
  unresolvedDiagnosis: false,
  criticality: "NORMAL",
  independentWorkstreams: 1,
  mechanical: false,
});

test("normal bounded product change selects Direct Work with audit", () => {
  const decision = selectExecutionMode(boundedTask);
  assert.equal(decision.mode, EXECUTION_MODES.DIRECT_WORK);
  assert.equal(decision.auditRequired, true);
  assert.equal(typeof decision.reason, "string");
  assert.ok(decision.reason.length > 0);
});

test("mechanical or explicitly low-risk work stays Direct Work without audit", () => {
  const decision = selectExecutionMode({
    ...boundedTask,
    mechanical: true,
    criticality: "LOW",
  });
  assert.equal(decision.mode, EXECUTION_MODES.DIRECT_WORK);
  assert.equal(decision.auditRequired, false);
});

test("open-ended unresolved diagnosis escalates to Guided Work", () => {
  const decision = selectExecutionMode({
    ...boundedTask,
    bounded: false,
    unresolvedDiagnosis: true,
  });
  assert.equal(decision.mode, EXECUTION_MODES.GUIDED_WORK);
  assert.equal(decision.auditRequired, true);
});

test("multiple independent workstreams escalate to Orchestrated Work", () => {
  const decision = selectExecutionMode({
    ...boundedTask,
    independentWorkstreams: 3,
  });
  assert.equal(decision.mode, EXECUTION_MODES.ORCHESTRATED_WORK);
  assert.equal(decision.auditRequired, true);
});

test("critical migrations escalate to Orchestrated Work", () => {
  const decision = selectExecutionMode({
    ...boundedTask,
    criticality: "CRITICAL",
    migrationSensitive: true,
  });
  assert.equal(decision.mode, EXECUTION_MODES.ORCHESTRATED_WORK);
});

test("explicit execution-mode policy may escalate but never depends on provider/model identity", () => {
  const baseline = selectExecutionMode(boundedTask);
  const providerDecorated = selectExecutionMode({
    ...boundedTask,
    provider: "codex",
    model: "gpt-6-sol",
    executor: "luna-max",
    session_id: "provider-specific-provenance",
  });
  assert.deepEqual(providerDecorated, baseline);

  const explicitGuided = selectExecutionMode({
    ...boundedTask,
    requestedMode: "GUIDED_WORK",
  });
  assert.equal(explicitGuided.mode, EXECUTION_MODES.GUIDED_WORK);
});

test("Direct Work state vocabulary is stable and provider-neutral", () => {
  assert.deepEqual(DIRECT_WORK_STATES, Object.freeze({
    INTAKE: "INTAKE",
    RESOLVING: "RESOLVING",
    IMPLEMENTATION_READY: "IMPLEMENTATION_READY",
    IMPLEMENTING: "IMPLEMENTING",
    CANDIDATE_READY: "CANDIDATE_READY",
    EVIDENCE_PENDING: "EVIDENCE_PENDING",
    AUDIT_PENDING: "AUDIT_PENDING",
    ACCEPTANCE: "ACCEPTANCE",
    DONE: "DONE",
    BLOCKED: "BLOCKED",
    HUMAN_GATE: "HUMAN_GATE",
  }));
});

test("Direct Work state transitions follow the bounded candidate lifecycle", () => {
  const sequence = [
    [DIRECT_WORK_STATES.INTAKE, "RESOLVE", DIRECT_WORK_STATES.RESOLVING],
    [DIRECT_WORK_STATES.RESOLVING, "IMPLEMENTATION_READY", DIRECT_WORK_STATES.IMPLEMENTATION_READY],
    [DIRECT_WORK_STATES.IMPLEMENTATION_READY, "START_IMPLEMENTATION", DIRECT_WORK_STATES.IMPLEMENTING],
    [DIRECT_WORK_STATES.IMPLEMENTING, "CANDIDATE_CREATED", DIRECT_WORK_STATES.CANDIDATE_READY],
    [DIRECT_WORK_STATES.CANDIDATE_READY, "EVIDENCE_REQUIRED", DIRECT_WORK_STATES.EVIDENCE_PENDING],
    [DIRECT_WORK_STATES.EVIDENCE_PENDING, "VERIFICATION_COMPLETE", DIRECT_WORK_STATES.ACCEPTANCE],
    [DIRECT_WORK_STATES.ACCEPTANCE, "ACCEPT", DIRECT_WORK_STATES.DONE],
  ];

  for (const [state, event, expected] of sequence) {
    assert.deepEqual(transitionDirectWork(state, event), {
      allowed: true,
      nextState: expected,
      reason: "ALLOWED_TRANSITION",
    });
  }
});

test("audit-pending branch can converge on acceptance without changing provider semantics", () => {
  assert.deepEqual(transitionDirectWork(DIRECT_WORK_STATES.CANDIDATE_READY, "AUDIT_REQUIRED"), {
    allowed: true,
    nextState: DIRECT_WORK_STATES.AUDIT_PENDING,
    reason: "ALLOWED_TRANSITION",
  });
  assert.deepEqual(transitionDirectWork(DIRECT_WORK_STATES.AUDIT_PENDING, "VERIFICATION_COMPLETE"), {
    allowed: true,
    nextState: DIRECT_WORK_STATES.ACCEPTANCE,
    reason: "ALLOWED_TRANSITION",
  });
});

test("invalid transitions fail closed and terminal states do not silently reopen", () => {
  assert.deepEqual(transitionDirectWork(DIRECT_WORK_STATES.INTAKE, "ACCEPT"), {
    allowed: false,
    nextState: DIRECT_WORK_STATES.INTAKE,
    reason: "TRANSITION_NOT_ALLOWED",
  });
  assert.deepEqual(transitionDirectWork(DIRECT_WORK_STATES.DONE, "START_IMPLEMENTATION"), {
    allowed: false,
    nextState: DIRECT_WORK_STATES.DONE,
    reason: "TERMINAL_STATE",
  });
});

test("control may explicitly block or request a human gate before completion", () => {
  assert.deepEqual(transitionDirectWork(DIRECT_WORK_STATES.IMPLEMENTING, "BLOCK"), {
    allowed: true,
    nextState: DIRECT_WORK_STATES.BLOCKED,
    reason: "ALLOWED_TRANSITION",
  });
  assert.deepEqual(transitionDirectWork(DIRECT_WORK_STATES.ACCEPTANCE, "HUMAN_GATE"), {
    allowed: true,
    nextState: DIRECT_WORK_STATES.HUMAN_GATE,
    reason: "ALLOWED_TRANSITION",
  });
});
