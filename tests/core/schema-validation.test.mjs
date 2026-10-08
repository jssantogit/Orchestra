import test from "node:test";
import assert from "node:assert/strict";

import { validateSchema } from "../../core/schema/validator.mjs";

const validImplementationPacket = () => ({
  schema: "orchestra.implementation-packet.v1",
  taskId: "chapter-refresh-fix",
  candidateGeneration: 17,
  goal: "correct chapter updates after refresh",
  direction: {
    cause: "observer can retain a stale snapshot after persistence",
    change: "invalidate the snapshot after successful persistence",
    preserve: ["current offline behavior", "public API"],
  },
  anchors: [
    { symbol: "ChapterRepository.refresh" },
    { symbol: "observeChapters" },
    { testHint: "ChapterRepositoryTest" },
  ],
  scope: {
    allowedAreas: ["domain/chapter/**", "data/chapter/**"],
    forbidden: ["unrelated cache refactor", "public API redesign"],
  },
  permissions: {
    discovery: "DIRECTED",
    tests: "MODIFY_AUTHORIZED_TARGETS",
    sideEffects: ["WORKSPACE_EDIT", "LOCAL_TEST"],
  },
  validation: ["affected repository tests", "formatter"],
  failurePolicy: {
    selfCaused: "REPAIR",
    unrelatedOrUncertain: "RETURN_TO_CONTROL",
  },
});

const validWorkLease = () => ({
  schema: "orchestra.work-lease.v1",
  projectLineage: "tsuzuki",
  workspaceId: "primary",
  taskId: "chapter-refresh-fix",
  generation: 18,
  state: "IMPLEMENTING",
  actor: {
    provider: "codex",
    sessionIdHash: "sha256:abc123",
  },
  capabilities: ["WORKSPACE_EDIT"],
  candidate: null,
});

test("implementation packet accepts the approved Direct Work shape", () => {
  const result = validateSchema("implementation-packet.v1.schema.json", validImplementationPacket());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test("implementation packet fails closed on missing identity, invalid discovery, and unknown narrative state", () => {
  const missingTask = validImplementationPacket();
  delete missingTask.taskId;
  assert.equal(validateSchema("implementation-packet.v1.schema.json", missingTask).valid, false);

  const invalidDiscovery = validImplementationPacket();
  invalidDiscovery.permissions.discovery = "BROAD";
  assert.equal(validateSchema("implementation-packet.v1.schema.json", invalidDiscovery).valid, false);

  for (const forbiddenField of ["transcript", "reasoning", "conversationHistory"]) {
    const packet = validImplementationPacket();
    packet[forbiddenField] = "must never become canonical state";
    assert.equal(
      validateSchema("implementation-packet.v1.schema.json", packet).valid,
      false,
      `${forbiddenField} must be rejected`,
    );
  }
});

test("work lease requires factual bounded authority fields and a non-negative generation", () => {
  const valid = validateSchema("work-lease.v1.schema.json", validWorkLease());
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));

  for (const requiredField of ["workspaceId", "taskId", "state", "actor", "capabilities"]) {
    const lease = validWorkLease();
    delete lease[requiredField];
    assert.equal(validateSchema("work-lease.v1.schema.json", lease).valid, false, `${requiredField} is required`);
  }

  const negativeGeneration = validWorkLease();
  negativeGeneration.generation = -1;
  assert.equal(validateSchema("work-lease.v1.schema.json", negativeGeneration).valid, false);
});

test("every canonical schema rejects unknown top-level properties", () => {
  const fixtures = {
    "implementation-packet.v1.schema.json": validImplementationPacket(),
    "scope-contract.v2.schema.json": {
      schema: "orchestra.scope-contract.v2",
      taskId: "task-1",
      allowedPaths: ["src/**"],
      forbiddenPaths: ["secrets/**"],
      acceptanceCriteria: ["behavior preserved"],
      requiredEvidence: ["focused-tests"],
      sideEffectCapabilities: ["WORKSPACE_EDIT"],
      stopConditions: ["scope conflict"],
      retryBudget: 2,
    },
    "candidate.v1.schema.json": {
      schema: "orchestra.candidate.v1",
      taskId: "task-1",
      candidateId: "candidate-1",
      generation: 1,
      workspaceId: "primary",
      headSha: "abcdef1",
    },
    "evidence.v1.schema.json": {
      schema: "orchestra.evidence.v1",
      taskId: "task-1",
      candidateId: "candidate-1",
      candidateGeneration: 1,
      kind: "TEST",
      status: "PASSED",
      source: { provider: "local", reference: "node --test" },
    },
    "audit-result.v1.schema.json": {
      schema: "orchestra.audit-result.v1",
      taskId: "task-1",
      candidateId: "candidate-1",
      candidateGeneration: 1,
      verdict: "PASS",
      findings: [],
    },
    "work-lease.v1.schema.json": validWorkLease(),
    "runtime-event.v1.schema.json": {
      schema: "orchestra.runtime-event.v1",
      eventId: "event-1",
      type: "CANDIDATE_READY",
      generation: 1,
      taskId: "task-1",
      actor: { provider: "codex", sessionIdHash: "sha256:abc123" },
      payload: {},
    },
  };

  for (const [schemaFile, fixture] of Object.entries(fixtures)) {
    const withUnknown = { ...fixture, unknownTopLevel: true };
    const result = validateSchema(schemaFile, withUnknown);
    assert.equal(result.valid, false, `${schemaFile} must reject unknown top-level fields`);
  }
});
