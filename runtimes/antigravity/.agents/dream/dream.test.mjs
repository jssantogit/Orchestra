import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalize, sha256Canonical } from "./canonical.mjs";
import {
  DREAM_SCHEMAS,
  createDreamEvent,
  validateDreamRecord,
} from "./records.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("dream canonicalization sorts object keys but preserves ordered arrays", () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), canonicalize({ a: 1, b: 2 }));
  assert.equal(
    canonicalize({ z: { b: 2, a: 1 }, y: [1, 2] }),
    canonicalize({ y: [1, 2], z: { a: 1, b: 2 } }),
  );
  assert.notEqual(canonicalize({ xs: ["a", "b"] }), canonicalize({ xs: ["b", "a"] }));
});

test("dream canonicalization sorts only schema-declared set arrays", () => {
  const a = { allowedPaths: ["b/**", "a/**"] };
  const b = { allowedPaths: ["a/**", "b/**"] };
  assert.equal(
    canonicalize(a, { setLikeKeys: new Set(["allowedPaths"]) }),
    canonicalize(b, { setLikeKeys: new Set(["allowedPaths"]) }),
  );

  // setLikeKeys accepts an Array or Set
  assert.equal(
    canonicalize(a, { setLikeKeys: ["allowedPaths"] }),
    canonicalize(b, { setLikeKeys: ["allowedPaths"] }),
  );

  // Deeply nested objects under set-like keys sort by canonical element representation
  const objSetA = {
    nested: {
      tags: [{ id: 2, name: "b" }, { id: 1, name: "a" }],
      ordered: [2, 1],
    },
  };
  const objSetB = {
    nested: {
      tags: [{ name: "a", id: 1 }, { name: "b", id: 2 }],
      ordered: [2, 1],
    },
  };
  assert.equal(
    canonicalize(objSetA, { setLikeKeys: new Set(["tags"]) }),
    canonicalize(objSetB, { setLikeKeys: new Set(["tags"]) }),
  );

  // Normal arrays preserve order even if nested beside set-like keys
  const normalA = { items: ["b", "a"] };
  const normalB = { items: ["a", "b"] };
  assert.notEqual(
    canonicalize(normalA, { setLikeKeys: new Set(["allowedPaths"]) }),
    canonicalize(normalB, { setLikeKeys: new Set(["allowedPaths"]) }),
  );
});

test("dream canonicalization rejects non-finite numbers and undefined", () => {
  assert.throws(() => canonicalize(undefined), /undefined/i);
  assert.throws(() => canonicalize({ a: undefined }), /undefined/i);
  assert.throws(() => canonicalize([undefined]), /undefined/i);

  assert.throws(() => canonicalize(NaN), /non-finite|NaN/i);
  assert.throws(() => canonicalize({ n: NaN }), /non-finite|NaN/i);
  assert.throws(() => canonicalize([NaN]), /non-finite|NaN/i);

  assert.throws(() => canonicalize(Infinity), /non-finite|infinity/i);
  assert.throws(() => canonicalize(-Infinity), /non-finite|infinity/i);
  assert.throws(() => canonicalize({ inf: Infinity }), /non-finite|infinity/i);

  assert.throws(() => canonicalize(() => {}), /function/i);
  assert.throws(() => canonicalize({ fn: () => {} }), /function/i);
  assert.throws(() => canonicalize(Symbol("sym")), /symbol/i);
  assert.throws(() => canonicalize(123n), /bigint/i);
  assert.throws(() => canonicalize(new Date()), /unsupported/i);
  assert.throws(() => canonicalize(new Map()), /unsupported/i);
  assert.throws(() => canonicalize(new Set()), /unsupported/i);
});

test("dream canonicalization does not alter or strip keys inside values", () => {
  const input = { a: null, b: false, c: 0, d: "", e: { nested: true } };
  const serialized = canonicalize(input);
  assert.equal(
    serialized,
    '{"a":null,"b":false,"c":0,"d":"","e":{"nested":true}}',
  );
});

test("sha256Canonical produces deterministic sha256 lowercase hex string", () => {
  const hash1 = sha256Canonical({ b: 2, a: 1 });
  const hash2 = sha256Canonical({ a: 1, b: 2 });
  assert.equal(hash1, hash2);
  assert.match(hash1, /^sha256:[0-9a-f]{64}$/);
});

test("createDreamEvent produces event_hash excluding event_hash from input", () => {
  const ev1 = createDreamEvent("DECISION", {
    decision_id: "dec-123",
    chosen_action: "FLASH_MEDIUM",
  });
  assert.equal(ev1.type, "DECISION");
  assert.equal(ev1.decision_id, "dec-123");
  assert.equal(ev1.chosen_action, "FLASH_MEDIUM");
  assert.match(ev1.event_hash, /^sha256:[0-9a-f]{64}$/);

  // Calling createDreamEvent with existing or tampered event_hash computes over base without event_hash
  const ev2 = createDreamEvent("DECISION", {
    decision_id: "dec-123",
    chosen_action: "FLASH_MEDIUM",
    event_hash: "sha256:tampered_hash_that_should_be_ignored",
  });
  assert.equal(ev2.event_hash, ev1.event_hash);
  assert.notEqual(ev2.event_hash, "sha256:tampered_hash_that_should_be_ignored");

  // Verify hash matches manual calculation without event_hash
  const expectedHash = sha256Canonical({
    chosen_action: "FLASH_MEDIUM",
    decision_id: "dec-123",
    type: "DECISION",
  });
  assert.equal(ev1.event_hash, expectedHash);
});

test("DREAM_SCHEMAS constants match approved versions", () => {
  assert.equal(DREAM_SCHEMAS.SNAPSHOT, "orchestra.snapshot.v1");
  assert.equal(DREAM_SCHEMAS.DECISION, "orchestra.decision.v1");
  assert.equal(DREAM_SCHEMAS.OUTCOME, "orchestra.outcome.v1");
  assert.equal(DREAM_SCHEMAS.WORLD, "orchestra.world.v1");
  assert.throws(() => {
    DREAM_SCHEMAS.SNAPSHOT = "mutated";
  });
});

test("validateDreamRecord validates snapshot-v1 records", () => {
  const validSnapshot = {
    schema: "orchestra.snapshot.v1",
    snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    task_fingerprint: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    contract_fingerprint: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    runtime_fingerprint: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    workspace_fingerprint: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    environment_fingerprint: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    execution_state_identity: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
    evidence_fingerprint: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
  };
  const resValid = validateDreamRecord(DREAM_SCHEMAS.SNAPSHOT, validSnapshot);
  assert.equal(resValid.valid, true);
  assert.deepEqual(resValid.errors, []);

  // Also accepts kind as "SNAPSHOT"
  const resKind = validateDreamRecord("SNAPSHOT", validSnapshot);
  assert.equal(resKind.valid, true);

  // Missing required field
  const missingField = { ...validSnapshot };
  delete missingField.task_fingerprint;
  const resMissing = validateDreamRecord(DREAM_SCHEMAS.SNAPSHOT, missingField);
  assert.equal(resMissing.valid, false);
  assert.equal(resMissing.errors.length > 0, true);

  // Wrong schema version
  const wrongSchema = { ...validSnapshot, schema: "orchestra.snapshot.v2" };
  const resWrongSchema = validateDreamRecord(DREAM_SCHEMAS.SNAPSHOT, wrongSchema);
  assert.equal(resWrongSchema.valid, false);
});

test("validateDreamRecord validates decision-v1 records", () => {
  const validDecision = {
    schema: "orchestra.decision.v1",
    decision_id: "dec-11111111-2222-3333-4444-555555555555",
    parent_decision_id: null,
    snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    decision_type: "WORKER_TIER",
    state: {
      task_action: "IMPLEMENT",
      complexity: "NORMAL",
      criticality: "NORMAL",
    },
    available_actions: ["FLASH_MEDIUM", "FLASH_HIGH"],
    chosen_action: "FLASH_MEDIUM",
    policy_id: "static-policy-v1",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    created_at: "2026-09-17T12:00:00.000Z",
  };
  const resValid = validateDreamRecord(DREAM_SCHEMAS.DECISION, validDecision);
  assert.equal(resValid.valid, true);
  assert.deepEqual(resValid.errors, []);

  // Invalid decision_type
  const invalidType = { ...validDecision, decision_type: "UNSUPPORTED_TYPE" };
  const resInvalidType = validateDreamRecord(DREAM_SCHEMAS.DECISION, invalidType);
  assert.equal(resInvalidType.valid, false);

  // Chosen action not in available_actions
  const invalidAction = { ...validDecision, chosen_action: "FORBIDDEN_ACTION" };
  const resInvalidAction = validateDreamRecord(DREAM_SCHEMAS.DECISION, invalidAction);
  assert.equal(resInvalidAction.valid, false);
});

test("validateDreamRecord validates outcome-v1 records", () => {
  const validOutcome = {
    schema: "orchestra.outcome.v1",
    decision_id: "dec-11111111-2222-3333-4444-555555555555",
    observation_id: "obs-11111111-2222-3333-4444-555555555555",
    branch_instance_id: "br-11111111-2222-3333-4444-555555555555",
    result: "SUCCESS",
    resulting_snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    evidence_summary: {
      tests: "PASS",
      validation_fresh: true,
    },
    retry_state: {
      attempt: 1,
      retry_remaining: 1,
    },
    cost_metrics: {
      model_calls: 2,
      latency_ms: 1250,
    },
    terminal_state: "ACCEPTED",
    evidence_provenance: ["exec-123"],
    created_at: "2026-09-17T12:00:05.000Z",
  };
  const resValid = validateDreamRecord(DREAM_SCHEMAS.OUTCOME, validOutcome);
  assert.equal(resValid.valid, true);
  assert.deepEqual(resValid.errors, []);

  // Invalid terminal state
  const invalidTerminal = { ...validOutcome, terminal_state: "INVALID_TERMINAL" };
  const resInvalidTerminal = validateDreamRecord(DREAM_SCHEMAS.OUTCOME, invalidTerminal);
  assert.equal(resInvalidTerminal.valid, false);

  // Missing decision_id
  const missingDecId = { ...validOutcome };
  delete missingDecId.decision_id;
  const resMissingDecId = validateDreamRecord(DREAM_SCHEMAS.OUTCOME, missingDecId);
  assert.equal(resMissingDecId.valid, false);
});

test("validateDreamRecord validates world-v1 records", () => {
  const validWorld = {
    schema: "orchestra.world.v1",
    world_id: "world-11111111-2222-3333-4444-555555555555",
    root_snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    runtime_fingerprint: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    event_hashes: [
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "sha256:1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ],
    world_manifest_hash: "sha256:2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    status: "SEALED",
    created_at: "2026-09-17T12:00:10.000Z",
  };
  const resValid = validateDreamRecord(DREAM_SCHEMAS.WORLD, validWorld);
  assert.equal(resValid.valid, true);
  assert.deepEqual(resValid.errors, []);

  // Invalid status
  const invalidStatus = { ...validWorld, status: "NOT_A_REAL_STATUS" };
  const resInvalidStatus = validateDreamRecord(DREAM_SCHEMAS.WORLD, invalidStatus);
  assert.equal(resInvalidStatus.valid, false);
});

test("validateDreamRecord rejects non-object inputs and unknown kind", () => {
  assert.equal(validateDreamRecord("UNKNOWN_KIND", {}).valid, false);
  assert.equal(validateDreamRecord(DREAM_SCHEMAS.DECISION, null).valid, false);
  assert.equal(validateDreamRecord(DREAM_SCHEMAS.DECISION, "not an object").valid, false);
  assert.equal(validateDreamRecord(DREAM_SCHEMAS.DECISION, []).valid, false);
});

test("validateDreamRecord rejects unexpected authority escalation fields", () => {
  const forbiddenKeys = [
    "override_governance",
    "retry_budget_override",
    "provider",
    "active_policy",
    "exploration_budget_override",
  ];

  const baseRecord = {
    schema: "orchestra.decision.v1",
    decision_id: "dec-1",
    parent_decision_id: null,
    snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_id: "static",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    created_at: "2026-09-17T12:00:00.000Z",
  };

  for (const forbidden of forbiddenKeys) {
    const record = { ...baseRecord, [forbidden]: true };
    const res = validateDreamRecord(DREAM_SCHEMAS.DECISION, record);
    assert.equal(
      res.valid,
      false,
      `Record containing authority field ${forbidden} must fail validation`,
    );
    assert.equal(
      res.errors.some((e) => e.includes(forbidden)),
      true,
      `Error messages should mention forbidden key ${forbidden}`,
    );

    // Also test deeply nested forbidden authority fields
    const nestedRecord = { ...baseRecord, state: { [forbidden]: "injected" } };
    const resNested = validateDreamRecord(DREAM_SCHEMAS.DECISION, nestedRecord);
    assert.equal(
      resNested.valid,
      false,
      `Record containing nested authority field ${forbidden} must fail validation`,
    );
  }
});

test("JSON schema files exist and are valid JSON Schema draft-07/2020-12 documents", () => {
  const schemaNames = [
    "snapshot-v1.schema.json",
    "decision-v1.schema.json",
    "outcome-v1.schema.json",
    "world-v1.schema.json",
  ];

  for (const schemaName of schemaNames) {
    const schemaPath = resolve(__dirname, "schemas", schemaName);
    const content = readFileSync(schemaPath, "utf8");
    const parsed = JSON.parse(content);

    assert.equal(typeof parsed, "object");
    assert.equal(parsed !== null, true);
    assert.equal(typeof parsed.$schema, "string");
    assert.equal(typeof parsed.title, "string");
    assert.equal(typeof parsed.type, "string");
    assert.equal(parsed.type, "object");
    assert.equal(typeof parsed.properties, "object");
    assert.equal(Array.isArray(parsed.required), true);
  }
});
