import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DISCOVERY_MODES,
  assertImplementationPacket,
  validateImplementationPacket,
} from "../../core/domain/implementation-packet.mjs";
import { assertScopeContract, validateScopeContract } from "../../core/domain/scope-contract.mjs";
import { assertCandidate, validateCandidate } from "../../core/domain/candidate.mjs";
import { assertEvidence, validateEvidence } from "../../core/domain/evidence.mjs";
import { assertAuditResult, validateAuditResult } from "../../core/domain/audit-result.mjs";
import { assertWorkLease, validateWorkLease } from "../../core/domain/work-lease.mjs";
import { assertRuntimeEvent, validateRuntimeEvent } from "../../core/domain/runtime-event.mjs";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

const fixtures = {
  packet: {
    schema: "orchestra.implementation-packet.v1",
    taskId: "task-1",
    candidateGeneration: 1,
    goal: "apply resolved change",
    direction: { change: "change the bounded target", preserve: ["public API"] },
    anchors: [{ symbol: "Target.apply" }],
    scope: { allowedAreas: ["src/**"], forbidden: ["unrelated/**"] },
    permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: ["WORKSPACE_EDIT"] },
    validation: ["focused tests"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  },
  scope: {
    schema: "orchestra.scope-contract.v2",
    taskId: "task-1",
    allowedPaths: ["src/**"],
    forbiddenPaths: ["secrets/**"],
    acceptanceCriteria: ["behavior preserved"],
    requiredEvidence: ["focused-tests"],
    sideEffectCapabilities: ["WORKSPACE_EDIT"],
    stopConditions: ["scope conflict"],
    retryBudget: 1,
  },
  candidate: {
    schema: "orchestra.candidate.v1",
    taskId: "task-1",
    candidateId: "candidate-1",
    generation: 1,
    workspaceId: "primary",
    headSha: "abcdef1",
  },
  evidence: {
    schema: "orchestra.evidence.v1",
    taskId: "task-1",
    candidateId: "candidate-1",
    candidateGeneration: 1,
    kind: "TEST",
    status: "PASSED",
    source: { provider: "local", reference: "node --test" },
  },
  audit: {
    schema: "orchestra.audit-result.v1",
    taskId: "task-1",
    candidateId: "candidate-1",
    candidateGeneration: 1,
    verdict: "PASS",
    findings: [],
  },
  lease: {
    schema: "orchestra.work-lease.v1",
    projectLineage: "project-lineage",
    workspaceId: "primary",
    taskId: "task-1",
    generation: 1,
    state: "IMPLEMENTING",
    actor: { provider: "codex", sessionIdHash: "sha256:abc" },
    capabilities: ["WORKSPACE_EDIT"],
    candidate: null,
  },
  event: {
    schema: "orchestra.runtime-event.v1",
    eventId: "event-1",
    type: "IMPLEMENTATION_READY",
    generation: 1,
    taskId: "task-1",
    actor: { provider: "codex", sessionIdHash: "sha256:abc" },
    payload: {},
  },
};

test("domain discovery constants exactly match the canonical schema vocabulary", () => {
  assert.deepEqual(DISCOVERY_MODES, {
    NONE: "NONE",
    DIRECTED: "DIRECTED",
    INVESTIGATIVE: "INVESTIGATIVE",
  });
  assert.equal(Object.isFrozen(DISCOVERY_MODES), true);
});

test("each domain contract is a thin schema-backed validator with an asserting counterpart", () => {
  const contracts = [
    [validateImplementationPacket, assertImplementationPacket, fixtures.packet],
    [validateScopeContract, assertScopeContract, fixtures.scope],
    [validateCandidate, assertCandidate, fixtures.candidate],
    [validateEvidence, assertEvidence, fixtures.evidence],
    [validateAuditResult, assertAuditResult, fixtures.audit],
    [validateWorkLease, assertWorkLease, fixtures.lease],
    [validateRuntimeEvent, assertRuntimeEvent, fixtures.event],
  ];

  for (const [validate, assertValid, fixture] of contracts) {
    assert.deepEqual(validate(fixture), { valid: true, errors: [] });
    assert.equal(assertValid(fixture), fixture);
    assert.equal(validate({ ...fixture, unexpectedDomainField: true }).valid, false);
    assert.throws(() => assertValid({ ...fixture, unexpectedDomainField: true }), {
      code: "ORCHESTRA_SCHEMA_INVALID",
    });
  }
});

test("provider session/model vocabulary is not a required or accepted top-level domain field", () => {
  for (const providerField of ["session_id", "conversationId", "model", "modelId"]) {
    assert.equal(validateImplementationPacket({ ...fixtures.packet, [providerField]: "gpt-6-sol" }).valid, false);
    assert.equal(validateWorkLease({ ...fixtures.lease, [providerField]: "gemini-3.8-flash" }).valid, false);
  }

  assert.equal(validateWorkLease(fixtures.lease).valid, true);
  assert.deepEqual(fixtures.lease.actor, { provider: "codex", sessionIdHash: "sha256:abc" });
});

test("core domain modules do not depend on provider trees, provider model SKUs, or external packages", async () => {
  const files = [
    "implementation-packet.mjs",
    "scope-contract.mjs",
    "candidate.mjs",
    "evidence.mjs",
    "audit-result.mjs",
    "work-lease.mjs",
    "runtime-event.mjs",
  ];

  for (const file of files) {
    const source = await readFile(resolve(repoRoot, "core", "domain", file), "utf8");
    assert.doesNotMatch(source, /runtimes\/(?:codex|antigravity)|gpt-[0-9]|gemini|from\s+["'](?:ajv|[^./])/i, file);
  }
});
