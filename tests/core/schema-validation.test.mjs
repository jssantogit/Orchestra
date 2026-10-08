import test from "node:test";
import assert from "node:assert/strict";

import { validateSchema, assertSchema } from "../../core/schema/validator.mjs";

const implementationPacket = {
  schema: "orchestra.implementation-packet.v1",
  taskId: "chapter-refresh-fix",
  candidateGeneration: 17,
  goal: "correct chapter updates after refresh",
  direction: {
    cause: "observer can retain a stale snapshot after persistence",
    change: "invalidate or refresh the snapshot after successful persistence",
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
};

test("implementation packet accepts the approved Direct Work shape", () => {
  const result = validateSchema("implementation-packet.v1.schema.json", implementationPacket);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(assertSchema("implementation-packet.v1.schema.json", implementationPacket), implementationPacket);
});

test("implementation packet fails closed on missing task identity", () => {
  const { taskId, ...invalid } = implementationPacket;
  const result = validateSchema("implementation-packet.v1.schema.json", invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.keyword === "required" && error.path === "/taskId"));
});

test("implementation packet rejects invalid discovery mode", () => {
  const invalid = structuredClone(implementationPacket);
  invalid.permissions.discovery = "BROAD";
  const result = validateSchema("implementation-packet.v1.schema.json", invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === "/permissions/discovery"));
});

test("canonical schemas reject unknown top-level transcript and reasoning fields", () => {
  for (const field of ["transcript", "hiddenReasoning", "session_id", "conversationId"]) {
    const invalid = { ...implementationPacket, [field]: "not canonical state" };
    const result = validateSchema("implementation-packet.v1.schema.json", invalid);
    assert.equal(result.valid, false, `${field} must be rejected`);
    assert.ok(result.errors.some((error) => error.keyword === "additionalProperties"));
  }
});

test("work lease requires factual generation workspace task actor and capabilities", () => {
  const valid = {
    schema: "orchestra.work-lease.v1",
    projectLineage: "tsuzuki",
    workspaceId: "primary",
    taskId: "chapter-refresh-fix",
    generation: 18,
    state: "IMPLEMENTING",
    actor: { provider: "codex", sessionIdHash: "sha256:abc" },
    capabilities: ["WORKSPACE_EDIT"],
    candidate: null,
  };

  assert.equal(validateSchema("work-lease.v1.schema.json", valid).valid, true);

  for (const field of ["workspaceId", "taskId", "actor", "capabilities"]) {
    const invalid = { ...valid };
    delete invalid[field];
    assert.equal(validateSchema("work-lease.v1.schema.json", invalid).valid, false, `${field} must be required`);
  }

  assert.equal(validateSchema("work-lease.v1.schema.json", { ...valid, generation: -1 }).valid, false);
});

test("all canonical schemas reject unknown top-level properties", () => {
  const fixtures = {
    "scope-contract.v2.schema.json": {
      schema: "orchestra.scope-contract.v2", taskId: "t", allowedPaths: ["src/**"], forbiddenPaths: [], acceptanceCriteria: ["works"], requiredEvidence: ["tests"], sideEffectCapabilities: ["WORKSPACE_EDIT"], stopConditions: ["scope_conflict"], retryBudget: 1,
    },
    "candidate.v1.schema.json": { schema: "orchestra.candidate.v1", taskId: "t", generation: 1, identity: "abc", changedPaths: ["src/a.mjs"] },
    "evidence.v1.schema.json": { schema: "orchestra.evidence.v1", taskId: "t", candidateGeneration: 1, kind: "TEST", status: "PASSED", reference: "run:1" },
    "audit-result.v1.schema.json": { schema: "orchestra.audit-result.v1", taskId: "t", candidateGeneration: 1, verdict: "PASS", findings: [] },
    "runtime-event.v1.schema.json": { schema: "orchestra.runtime-event.v1", eventId: "e1", taskId: "t", type: "CANDIDATE_READY", timestamp: "2026-10-08T00:00:00Z", data: {} },
  };

  for (const [schemaFile, fixture] of Object.entries(fixtures)) {
    assert.equal(validateSchema(schemaFile, fixture).valid, true, `${schemaFile} fixture must be valid`);
    assert.equal(validateSchema(schemaFile, { ...fixture, unexpected: true }).valid, false, `${schemaFile} must fail closed`);
  }
});
