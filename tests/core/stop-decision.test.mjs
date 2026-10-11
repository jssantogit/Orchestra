import test from "node:test";
import assert from "node:assert/strict";

import { STOP_DECISIONS, evaluateStopDecision } from "../../core/acceptance/stop-decision.mjs";

const packet = Object.freeze({
  schema: "orchestra.implementation-packet.v1",
  taskId: "task-1",
  candidateGeneration: 3,
  goal: "Fix the bounded bug",
  direction: { cause: "known cause", change: "apply bounded fix", preserve: [] },
  anchors: [{ file: "src/app.mjs" }],
  scope: { allowedAreas: ["src/**"], forbidden: [] },
  permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: [] },
  validation: ["FOCUSED_TEST"],
  failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
});
const candidate = Object.freeze({ schema: "orchestra.candidate.v1", taskId: "task-1", candidateId: "candidate-3", generation: 3, workspaceId: "primary", headSha: "abc" });
const evidence = Object.freeze([{ schema: "orchestra.evidence.v1", taskId: "task-1", candidateId: "candidate-3", candidateGeneration: 3, kind: "FOCUSED_TEST", status: "PASSED", source: { provider: "local", reference: "test:1" } }]);
const lease = Object.freeze({ schema: "orchestra.work-lease.v1", workspaceId: "primary", generation: 8, actor: { provider: "codex", sessionIdHash: "sha256:root" }, capabilities: ["CONTROL", "WORKSPACE_EDIT"] });

test("passing Direct Work candidate is accepted only by control stop decision", () => {
  assert.deepEqual(evaluateStopDecision({ workflow: { mode: "DIRECT_WORK", auditRequired: false }, packet, candidate, evidence, audit: null, lease }), { decision: STOP_DECISIONS.ACCEPT, reason: "ACCEPTED" });
});

test("missing required evidence continues rather than accepting", () => {
  assert.deepEqual(evaluateStopDecision({ workflow: { mode: "DIRECT_WORK", auditRequired: false }, packet, candidate, evidence: [], audit: null, lease }), { decision: STOP_DECISIONS.CONTINUE, reason: "REQUIRED_EVIDENCE_NOT_PASSED" });
});

test("stale candidate-bound evidence returns authority to control", () => {
  const stale = [{ ...evidence[0], candidateGeneration: 2 }];
  assert.deepEqual(evaluateStopDecision({ workflow: { mode: "DIRECT_WORK", auditRequired: false }, packet, candidate, evidence: stale, audit: null, lease }), { decision: STOP_DECISIONS.RETURN_TO_CONTROL, reason: "STALE_EVIDENCE_GENERATION" });
});

test("human gate and invalid lease fail closed before acceptance", () => {
  assert.equal(evaluateStopDecision({ workflow: { humanGate: true }, packet, candidate, evidence, lease }).decision, STOP_DECISIONS.HUMAN_GATE);
  assert.equal(evaluateStopDecision({ workflow: {}, packet, candidate, evidence, lease: null }).decision, STOP_DECISIONS.BLOCKED);
});
