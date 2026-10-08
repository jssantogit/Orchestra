import test from "node:test";
import assert from "node:assert/strict";

import {
  DISCOVERY_MODES,
  validateImplementationPacket,
  assertImplementationPacket,
} from "../../core/domain/implementation-packet.mjs";
import { validateScopeContract, assertScopeContract } from "../../core/domain/scope-contract.mjs";
import { validateCandidate, assertCandidate } from "../../core/domain/candidate.mjs";
import { validateEvidence, assertEvidence } from "../../core/domain/evidence.mjs";
import { validateAuditResult, assertAuditResult } from "../../core/domain/audit-result.mjs";
import { validateWorkLease, assertWorkLease } from "../../core/domain/work-lease.mjs";
import { validateRuntimeEvent, assertRuntimeEvent } from "../../core/domain/runtime-event.mjs";

const packet = {
  schema: "orchestra.implementation-packet.v1",
  taskId: "t",
  candidateGeneration: 1,
  goal: "apply a resolved change",
  direction: { cause: "known cause", change: "known direction", preserve: [] },
  anchors: [{ symbol: "Known.symbol" }],
  scope: { allowedAreas: ["src/**"], forbidden: [] },
  permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: ["WORKSPACE_EDIT"] },
  validation: ["focused tests"],
  failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
};

const contract = {
  schema: "orchestra.scope-contract.v2",
  taskId: "t",
  allowedPaths: ["src/**"],
  forbiddenPaths: [],
  acceptanceCriteria: ["behavior is correct"],
  requiredEvidence: ["tests"],
  sideEffectCapabilities: ["WORKSPACE_EDIT"],
  stopConditions: ["scope_conflict"],
  retryBudget: 1,
};

const candidate = {
  schema: "orchestra.candidate.v1",
  taskId: "t",
  generation: 1,
  identity: "candidate-1",
  changedPaths: ["src/a.mjs"],
};

const evidence = {
  schema: "orchestra.evidence.v1",
  taskId: "t",
  candidateGeneration: 1,
  kind: "TEST",
  status: "PASSED",
  reference: "run:1",
};

const audit = {
  schema: "orchestra.audit-result.v1",
  taskId: "t",
  candidateGeneration: 1,
  verdict: "PASS",
  findings: [],
};

const lease = {
  schema: "orchestra.work-lease.v1",
  projectLineage: "project",
  workspaceId: "primary",
  taskId: "t",
  generation: 1,
  state: "IMPLEMENTING",
  actor: { provider: "codex", sessionIdHash: "sha256:abc" },
  capabilities: ["WORKSPACE_EDIT"],
  candidate: null,
};

const runtimeEvent = {
  schema: "orchestra.runtime-event.v1",
  eventId: "e1",
  taskId: "t",
  type: "CANDIDATE_READY",
  timestamp: "2026-10-08T00:00:00Z",
  data: {},
};

test("domain discovery constants exactly match the canonical schema enum", () => {
  assert.deepEqual(DISCOVERY_MODES, Object.freeze({ NONE: "NONE", DIRECTED: "DIRECTED", INVESTIGATIVE: "INVESTIGATIVE" }));
});

test("all domain validators and assertions are thin schema-backed contracts", () => {
  const cases = [
    [validateImplementationPacket, assertImplementationPacket, packet],
    [validateScopeContract, assertScopeContract, contract],
    [validateCandidate, assertCandidate, candidate],
    [validateEvidence, assertEvidence, evidence],
    [validateAuditResult, assertAuditResult, audit],
    [validateWorkLease, assertWorkLease, lease],
    [validateRuntimeEvent, assertRuntimeEvent, runtimeEvent],
  ];

  for (const [validate, assertValue, value] of cases) {
    assert.equal(validate(value).valid, true, JSON.stringify(validate(value).errors));
    assert.deepEqual(assertValue(value), value);
    assert.equal(validate({ ...value, unexpectedProviderField: true }).valid, false);
  }
});

test("provider model and hook vocabulary is not required canonical domain state", () => {
  const serialized = JSON.stringify({ packet, contract, candidate, evidence, audit, lease, runtimeEvent });
  for (const providerTerm of ["gpt-6-sol", "gemini-3", "conversationId", "session_id", "transcript_path"]) {
    assert.equal(serialized.includes(providerTerm), false, `${providerTerm} must not be required domain vocabulary`);
  }
});

test("provider identity is bounded to actor provenance instead of top-level authority fields", () => {
  assert.equal(validateWorkLease(lease).valid, true);
  assert.equal(validateWorkLease({ ...lease, session_id: "raw-session" }).valid, false);
  assert.equal(validateWorkLease({ ...lease, conversationId: "raw-conversation" }).valid, false);
  assert.equal(validateWorkLease({ ...lease, actor: { provider: "codex", sessionIdHash: "sha256:def" } }).valid, true);
});
