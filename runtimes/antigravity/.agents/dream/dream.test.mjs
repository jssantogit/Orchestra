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
import {
  deriveAvailableActions,
  deriveDecisionState,
  classifyBaselineDecision,
} from "./action-space.mjs";
import {
  dreamCorrelationKey,
  recordDecision,
} from "./decision-recorder.mjs";
import {
  getPendingDecision,
  recordDecisionOutcome,
} from "./outcome-recorder.mjs";

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

import {
  normalizeTaskSpec,
  buildWorkspaceManifest,
  buildTaskFingerprint,
  buildContractFingerprint,
  buildRuntimeFingerprint,
  buildEnvironmentFingerprint,
  buildExecutionStateIdentity,
  buildEvidenceFingerprint,
  buildSnapshot,
} from "./snapshot.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("normalizeTaskSpec normalizes CRLF and trailing whitespace while preserving indentation and blank lines", () => {
  const input = "  line 1   \r\n\r\n    line 2\t\t\r\n\n  line 3 ";
  const expected = "  line 1\n\n    line 2\n\n  line 3";
  assert.equal(normalizeTaskSpec(input), expected);
});

test("buildEnvironmentFingerprint stores only hashes of allowlisted variables and never cleartext", () => {
  const env = {
    NODE_ENV: "production",
    SECRET_API_KEY: "super-secret-token",
    CI: "true",
  };
  const fp = buildEnvironmentFingerprint(env, ["NODE_ENV", "CI"]);
  assert.equal("SECRET_API_KEY" in fp, false);
  assert.match(fp.NODE_ENV, /^sha256:[0-9a-f]{64}$/);
  assert.match(fp.CI, /^sha256:[0-9a-f]{64}$/);
  assert.equal(fp.NODE_ENV.includes("production"), false);
  assert.equal(fp.CI.includes("true"), false);
});

test("buildRuntimeFingerprint excludes active exploration policy from runtime identity", () => {
  const rt1 = {
    node_version: "v24.20.0",
    platform: "linux",
    arch: "x64",
    active_policy: "policy-alpha",
  };
  const rt2 = {
    node_version: "v24.20.0",
    platform: "linux",
    arch: "x64",
    active_policy: "policy-beta",
  };
  assert.equal(buildRuntimeFingerprint(rt1), buildRuntimeFingerprint(rt2));

  // Changing runtime property alters fingerprint
  const rt3 = { ...rt1, node_version: "v22.0.0" };
  assert.notEqual(buildRuntimeFingerprint(rt1), buildRuntimeFingerprint(rt3));
});

test("buildContractFingerprint treats set-like arrays as unordered sets", () => {
  const c1 = {
    allowed_paths: ["b.js", "a.js"],
    forbidden_paths: ["dir2/**", "dir1/**"],
    do_not_change: ["AGENTS.md", "README.md"],
    criteria: ["c2", "c1"],
    retry_budget: 2,
    domain: "CODE",
    criticality: "NORMAL",
  };
  const c2 = {
    allowed_paths: ["a.js", "b.js"],
    forbidden_paths: ["dir1/**", "dir2/**"],
    do_not_change: ["README.md", "AGENTS.md"],
    criteria: ["c1", "c2"],
    retry_budget: 2,
    domain: "CODE",
    criticality: "NORMAL",
  };
  assert.equal(buildContractFingerprint(c1), buildContractFingerprint(c2));

  // Modifying retry budget changes fingerprint
  const c3 = { ...c1, retry_budget: 3 };
  assert.notEqual(buildContractFingerprint(c1), buildContractFingerprint(c3));
});

test("snapshot builder and workspace manifest: comprehensive fixture tests", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-snapshot-test-"));
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Setup initial fixture files
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(join(tempDir, "src", "index.js"), "console.log('hello');\n");
  writeFileSync(join(tempDir, "README.md"), "# Test Project\n");

  // Add internal symlink
  symlinkSync("index.js", join(tempDir, "src", "link-to-index.js"));

  const baseTask = {
    spec: "Implement feature A   \r\n",
    task_action: "IMPLEMENT",
    task_domain: "CODE",
    criticality: "NORMAL",
  };

  const baseContract = {
    allowed_paths: ["src/**"],
    forbidden_paths: ["secrets/**"],
    do_not_change: ["README.md"],
    criteria: ["unit tests pass"],
    retry_budget: 2,
    domain: "CODE",
    criticality: "NORMAL",
  };

  const baseRuntime = {
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
  };

  const baseEnv = {
    NODE_ENV: "test",
    CI: "1",
  };

  const baseExecState = {
    step_sequence: 1,
    attempt: 1,
    retry_remaining: 2,
    mutation_seq: 1,
  };

  const baseEvidence = {
    tests: "PASS",
    typecheck: "PASS",
    build: "PASS",
    validation_fresh: true,
  };

  const baseInput = {
    repoRoot: tempDir,
    task: baseTask,
    contract: baseContract,
    runtime: baseRuntime,
    environment: baseEnv,
    executionState: baseExecState,
    evidence: baseEvidence,
  };

  // 1. Two consecutive snapshots of identical fixture workspace return identical snapshot_id
  const first = buildSnapshot(baseInput);
  assert.equal(first.ok, true);
  assert.match(first.snapshot.snapshot_id, /^sha256:[0-9a-f]{64}$/);

  const second = buildSnapshot(baseInput);
  assert.equal(second.ok, true);
  assert.equal(first.snapshot.snapshot_id, second.snapshot.snapshot_id);

  // 2. Modifying file content in workspace changes snapshot_id
  writeFileSync(join(tempDir, "src", "index.js"), "console.log('modified');\n");
  const afterContentChange = buildSnapshot(baseInput);
  assert.notEqual(first.snapshot.snapshot_id, afterContentChange.snapshot.snapshot_id);
  // Restore
  writeFileSync(join(tempDir, "src", "index.js"), "console.log('hello');\n");
  const restored = buildSnapshot(baseInput);
  assert.equal(first.snapshot.snapshot_id, restored.snapshot.snapshot_id);

  // 3. Modifying executable bit (chmod) changes snapshot_id
  chmodSync(join(tempDir, "src", "index.js"), 0o755);
  const afterChmod = buildSnapshot(baseInput);
  assert.notEqual(first.snapshot.snapshot_id, afterChmod.snapshot.snapshot_id);
  // Restore chmod
  chmodSync(join(tempDir, "src", "index.js"), 0o644);
  const restoredChmod = buildSnapshot(baseInput);
  assert.equal(first.snapshot.snapshot_id, restoredChmod.snapshot.snapshot_id);

  // 4. Modifying task spec changes snapshot_id
  const taskModified = { ...baseTask, spec: "Implement feature B" };
  const afterTaskChange = buildSnapshot({ ...baseInput, task: taskModified });
  assert.notEqual(first.snapshot.snapshot_id, afterTaskChange.snapshot.snapshot_id);

  // 5. Modifying contract changes snapshot_id
  const contractModified = { ...baseContract, retry_budget: 5 };
  const afterContractChange = buildSnapshot({ ...baseInput, contract: contractModified });
  assert.notEqual(first.snapshot.snapshot_id, afterContractChange.snapshot.snapshot_id);

  // 6. Modifying retry/evidence state changes snapshot_id
  const execModified = { ...baseExecState, retry_remaining: 0 };
  const afterExecChange = buildSnapshot({ ...baseInput, executionState: execModified });
  assert.notEqual(first.snapshot.snapshot_id, afterExecChange.snapshot.snapshot_id);

  const evidenceModified = { ...baseEvidence, tests: "FAIL" };
  const afterEvidenceChange = buildSnapshot({ ...baseInput, evidence: evidenceModified });
  assert.notEqual(first.snapshot.snapshot_id, afterEvidenceChange.snapshot.snapshot_id);

  // 7. Modifying runtime fingerprint changes snapshot_id
  const runtimeModified = { ...baseRuntime, node_version: "v18.0.0" };
  const afterRuntimeChange = buildSnapshot({ ...baseInput, runtime: runtimeModified });
  assert.notEqual(first.snapshot.snapshot_id, afterRuntimeChange.snapshot.snapshot_id);

  // 8. Adding or modifying files ONLY inside .agents/telemetry/, .agents/state/, .agents/dream-data/, node_modules/, dist/, or .git/ does NOT change snapshot_id
  const excludedDirs = [
    join(tempDir, ".agents", "telemetry"),
    join(tempDir, ".agents", "state"),
    join(tempDir, ".agents", "dream-data"),
    join(tempDir, "node_modules", "some-pkg"),
    join(tempDir, "dist"),
    join(tempDir, ".git", "objects"),
  ];
  for (const dir of excludedDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "temp-file.log"), "some ephemeral content\n");
    const snap = buildSnapshot(baseInput);
    assert.equal(
      snap.snapshot.snapshot_id,
      first.snapshot.snapshot_id,
      `Writing in ${dir} must not alter snapshot_id`,
    );
  }

  // 9. Symlink escaping repoRoot returns ok: false, reason: "EXTERNAL_SYMLINK_UNSAFE"
  const unsafeLink = join(tempDir, "src", "escaping-link");
  symlinkSync("/etc/passwd", unsafeLink);
  const unsafeRes = buildSnapshot(baseInput);
  assert.equal(unsafeRes.ok, false);
  assert.equal(unsafeRes.reason, "EXTERNAL_SYMLINK_UNSAFE");
  rmSync(unsafeLink, { force: true });

  // Relative escaping symlink
  symlinkSync("../../outside", unsafeLink);
  const unsafeRelativeRes = buildSnapshot(baseInput);
  assert.equal(unsafeRelativeRes.ok, false);
  assert.equal(unsafeRelativeRes.reason, "EXTERNAL_SYMLINK_UNSAFE");
  rmSync(unsafeLink, { force: true });

  // 10. Metadata cache reuse test (measure cache hits > 0 on second run)
  const cacheFile = join(tempDir, ".agents", "state", "dream", "test-metadata-cache.json");
  const manifestFirst = buildWorkspaceManifest(tempDir, { cacheFilePath: cacheFile });
  assert.equal(manifestFirst.ok, true);
  assert.equal(manifestFirst.cache_hits, 0);

  const manifestSecond = buildWorkspaceManifest(tempDir, { cacheFilePath: cacheFile });
  assert.equal(manifestSecond.ok, true);
  assert.ok(manifestSecond.cache_hits > 0, `Expected cache hits > 0, got ${manifestSecond.cache_hits}`);
});

test("buildExecutionStateIdentity produces deterministic identity sensitive to state fields", () => {
  const s1 = { step_sequence: 1, attempt: 1, retry_remaining: 2, mutation_seq: 1 };
  const s2 = { step_sequence: 1, attempt: 1, retry_remaining: 2, mutation_seq: 1 };
  assert.equal(buildExecutionStateIdentity(s1), buildExecutionStateIdentity(s2));

  assert.notEqual(
    buildExecutionStateIdentity(s1),
    buildExecutionStateIdentity({ ...s1, mutation_seq: 2 }),
  );
  assert.notEqual(
    buildExecutionStateIdentity(s1),
    buildExecutionStateIdentity({ ...s1, retry_remaining: 1 }),
  );
  assert.notEqual(
    buildExecutionStateIdentity(s1),
    buildExecutionStateIdentity({ ...s1, attempt: 2 }),
  );
  assert.notEqual(
    buildExecutionStateIdentity(s1),
    buildExecutionStateIdentity({ ...s1, step_sequence: 2 }),
  );
});

test("buildEvidenceFingerprint produces deterministic identity and treats ledger_hashes as a set", () => {
  const e1 = {
    tests: "PASS",
    typecheck: "PASS",
    build: "PASS",
    validation_fresh: true,
    ledger_hashes: ["sha256:bbbb", "sha256:aaaa"],
  };
  const e2 = {
    tests: "PASS",
    typecheck: "PASS",
    build: "PASS",
    validation_fresh: true,
    ledger_hashes: ["sha256:aaaa", "sha256:bbbb"],
  };
  assert.equal(buildEvidenceFingerprint(e1), buildEvidenceFingerprint(e2));

  assert.notEqual(
    buildEvidenceFingerprint(e1),
    buildEvidenceFingerprint({ ...e1, validation_fresh: false }),
  );
  assert.notEqual(
    buildEvidenceFingerprint(e1),
    buildEvidenceFingerprint({ ...e1, tests: "FAIL" }),
  );
});

test("buildWorkspaceManifest validates entry structure and handles corrupted cache gracefully", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-manifest-corrupt-"));
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  writeFileSync(join(tempDir, "sample.txt"), "some content");
  const cacheDir = join(tempDir, ".agents", "state", "dream");
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, "corrupt-cache.json");
  writeFileSync(cacheFile, "CORRUPT JSON NOT A DICT {{{");

  // Should not throw, should successfully hash and produce valid manifest
  const res = buildWorkspaceManifest(tempDir, { cacheFilePath: cacheFile });
  assert.equal(res.ok, true);
  assert.equal(res.cache_hits, 0);
  assert.equal(res.manifest.length, 1);
  assert.deepEqual(Object.keys(res.manifest[0]).sort(), [
    "content_hash",
    "executable",
    "path",
    "size",
    "type",
  ]);
  assert.equal(res.manifest[0].path, "sample.txt");
  assert.equal(res.manifest[0].type, "file");
  assert.match(res.manifest[0].content_hash, /^sha256:[0-9a-f]{64}$/);
});

test("buildSnapshot handles missing required parameters with descriptive reasons", () => {
  assert.equal(buildSnapshot({}).ok, false);
  assert.equal(buildSnapshot({}).reason, "MISSING_REPO_ROOT");
  assert.equal(buildSnapshot({ repoRoot: "/tmp" }).reason, "MISSING_TASK");
  assert.equal(buildSnapshot({ repoRoot: "/tmp", task: {} }).reason, "MISSING_CONTRACT");
  assert.equal(buildSnapshot({ repoRoot: "/tmp", task: {}, contract: {} }).reason, "MISSING_RUNTIME");
  assert.equal(
    buildSnapshot({ repoRoot: "/tmp", task: {}, contract: {}, runtime: {} }).reason,
    "MISSING_EXECUTION_STATE",
  );
  assert.equal(
    buildSnapshot({
      repoRoot: "/tmp",
      task: {},
      contract: {},
      runtime: {},
      executionState: {},
    }).reason,
    "MISSING_EVIDENCE",
  );
});

test("deriveAvailableActions: WORKER_TIER legal action space matches governance constraints", () => {
  // CRITICAL tasks have fixed governance outside Dream
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", { criticality: "CRITICAL" }),
    [],
  );

  // DIRECT_ACTION is outside Dream
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", { task_action: "DIRECT_ACTION" }),
    [],
  );

  // Mechanical / Simple / Docs tasks
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", { complexity: "MECHANICAL" }),
    ["FLASH_LOW", "FLASH_MEDIUM"],
  );
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", { complexity: "SIMPLE" }),
    ["FLASH_LOW", "FLASH_MEDIUM"],
  );
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", { task_domain: "DOCS" }),
    ["FLASH_LOW", "FLASH_MEDIUM"],
  );

  // Normal complexity
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", { complexity: "NORMAL" }),
    ["FLASH_MEDIUM", "FLASH_HIGH"],
  );

  // Difficult / Experimental / Integration / Post-investigation
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", { complexity: "DIFFICULT" }),
    ["FLASH_HIGH"],
  );
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", { complexity: "EXPERIMENTAL" }),
    ["FLASH_HIGH"],
  );
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", { complexity: "INTEGRATION" }),
    ["FLASH_HIGH"],
  );
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", { post_investigation: true }),
    ["FLASH_HIGH"],
  );

  // Default fallback
  assert.deepEqual(
    deriveAvailableActions("WORKER_TIER", {}),
    ["FLASH_MEDIUM", "FLASH_HIGH"],
  );
});

test("deriveAvailableActions: INVESTIGATION_STRATEGY legal action space matches eligibility rules", () => {
  // Eligible: mutation_seq === 0, criticality !== CRITICAL, task_action === IMPLEMENT
  assert.deepEqual(
    deriveAvailableActions("INVESTIGATION_STRATEGY", {
      mutation_seq: 0,
      criticality: "NORMAL",
      task_action: "IMPLEMENT",
      complexity: "NORMAL",
    }),
    ["IMPLEMENT_DIRECT", "INVESTIGATE_FIRST"],
  );

  // Eligible when mutation_seq is undefined
  assert.deepEqual(
    deriveAvailableActions("INVESTIGATION_STRATEGY", {
      criticality: "NORMAL",
      task_action: "IMPLEMENT",
      complexity: "NORMAL",
    }),
    ["IMPLEMENT_DIRECT", "INVESTIGATE_FIRST"],
  );

  // Ineligible when mutations have occurred
  assert.deepEqual(
    deriveAvailableActions("INVESTIGATION_STRATEGY", {
      mutation_seq: 1,
      criticality: "NORMAL",
      task_action: "IMPLEMENT",
    }),
    [],
  );

  // Ineligible when CRITICAL
  assert.deepEqual(
    deriveAvailableActions("INVESTIGATION_STRATEGY", {
      mutation_seq: 0,
      criticality: "CRITICAL",
      task_action: "IMPLEMENT",
    }),
    [],
  );

  // Ineligible when DIRECT_ACTION
  assert.deepEqual(
    deriveAvailableActions("INVESTIGATION_STRATEGY", {
      mutation_seq: 0,
      criticality: "NORMAL",
      task_action: "DIRECT_ACTION",
    }),
    [],
  );

  // Ineligible when MECHANICAL
  assert.deepEqual(
    deriveAvailableActions("INVESTIGATION_STRATEGY", {
      mutation_seq: 0,
      criticality: "NORMAL",
      task_action: "IMPLEMENT",
      complexity: "MECHANICAL",
    }),
    [],
  );
  assert.deepEqual(
    deriveAvailableActions("INVESTIGATION_STRATEGY", {
      mutation_seq: 0,
      criticality: "NORMAL",
      task_action: "MECHANICAL_FIX",
    }),
    [],
  );

  // Ineligible when already INVESTIGATE
  assert.deepEqual(
    deriveAvailableActions("INVESTIGATION_STRATEGY", {
      mutation_seq: 0,
      criticality: "NORMAL",
      task_action: "INVESTIGATE",
    }),
    [],
  );

  // Ineligible when post_investigation is already true
  assert.deepEqual(
    deriveAvailableActions("INVESTIGATION_STRATEGY", {
      mutation_seq: 0,
      criticality: "NORMAL",
      task_action: "IMPLEMENT",
      post_investigation: true,
    }),
    [],
  );
});

test("deriveAvailableActions: RETRY_ACTION legal action space by retry reason", () => {
  assert.deepEqual(
    deriveAvailableActions("RETRY_ACTION", { retry_reason: "FAILED_TEST" }),
    ["RETRY_SAME", "ESCALATE_WORKER", "INVESTIGATE_FIRST"],
  );

  assert.deepEqual(
    deriveAvailableActions("RETRY_ACTION", { retry_reason: "INCOMPLETE_IMPLEMENTATION" }),
    ["RETRY_SAME", "ESCALATE_WORKER"],
  );

  assert.deepEqual(
    deriveAvailableActions("RETRY_ACTION", { retry_reason: "MISSING_CONTEXT" }),
    ["INVESTIGATE_FIRST", "REPLAN"],
  );

  assert.deepEqual(
    deriveAvailableActions("RETRY_ACTION", { retry_reason: "MISINTERPRETED_REQUIREMENT" }),
    ["REPLAN"],
  );

  assert.deepEqual(
    deriveAvailableActions("RETRY_ACTION", { retry_reason: "SCOPE_GAP" }),
    ["REPLAN"],
  );

  assert.deepEqual(
    deriveAvailableActions("RETRY_ACTION", { retry_reason: "INTEGRATION_FAILURE" }),
    ["ESCALATE_WORKER", "REPLAN"],
  );

  // Unknown or unrecognized retry reason
  assert.deepEqual(
    deriveAvailableActions("RETRY_ACTION", { retry_reason: "UNKNOWN_REASON" }),
    [],
  );
  assert.deepEqual(
    deriveAvailableActions("RETRY_ACTION", {}),
    [],
  );

  // Unknown decisionType
  assert.deepEqual(
    deriveAvailableActions("UNKNOWN_DECISION_TYPE", {}),
    [],
  );
});

test("deriveDecisionState produces compact policy-visible state without leaking raw code or prompts", () => {
  const facts = {
    taskAction: "IMPLEMENT",
    taskDomain: "CODE",
    criticality: "NORMAL",
    complexity: "NORMAL",
    // Dangerous raw data that MUST NOT leak into policy-visible decision state:
    prompt: "Write a function foo that computes bar",
    rawCode: "function foo() { return 42; }",
    sourceCode: "const x = 1;",
    stackTrace: "Error: failure at index.js:10\n    at Object.<anonymous>",
    chatHistory: [
      { role: "user", content: "Please fix the bug" },
      { role: "assistant", content: "Working on it" },
    ],
  };

  const activeState = {
    state: "EXECUTING",
    attempt: 1,
    retry_remaining: 2,
    retry_reason: "FAILED_TEST",
    mutation_seq: 3,
    post_investigation: false,
    rawPrompt: "System instructions...",
  };

  const evidenceSummary = {
    tests: "FAIL",
    typecheck: "PASS",
    build: "PASS",
    scope_check: "PASS",
    validation_fresh: true,
  };

  const state = deriveDecisionState(facts, activeState, evidenceSummary);

  // Verify exact keys present in decision state
  const allowedKeys = [
    "task_action",
    "task_domain",
    "criticality",
    "complexity",
    "state",
    "attempt",
    "retry_remaining",
    "retry_reason",
    "mutation_seq",
    "post_investigation",
    "evidence",
  ];
  assert.deepEqual(Object.keys(state).sort(), allowedKeys.sort());

  // Assert no leak of raw data
  assert.equal(state.prompt, undefined);
  assert.equal(state.rawCode, undefined);
  assert.equal(state.sourceCode, undefined);
  assert.equal(state.stackTrace, undefined);
  assert.equal(state.chatHistory, undefined);
  assert.equal(state.rawPrompt, undefined);

  // Assert correct values
  assert.equal(state.task_action, "IMPLEMENT");
  assert.equal(state.task_domain, "CODE");
  assert.equal(state.criticality, "NORMAL");
  assert.equal(state.complexity, "NORMAL");
  assert.equal(state.state, "EXECUTING");
  assert.equal(state.attempt, 1);
  assert.equal(state.retry_remaining, 2);
  assert.equal(state.retry_reason, "FAILED_TEST");
  assert.equal(state.mutation_seq, 3);
  assert.equal(state.post_investigation, false);

  assert.deepEqual(state.evidence, {
    tests: "FAIL",
    typecheck: "PASS",
    build: "PASS",
    scope_check: "PASS",
    validation_fresh: true,
  });
});

test("deriveDecisionState handles missing evidence safely as explicit UNKNOWN (never inferred as PASS)", () => {
  const state = deriveDecisionState({}, {}, {});
  assert.deepEqual(state.evidence, {
    tests: "UNKNOWN",
    typecheck: "UNKNOWN",
    build: "UNKNOWN",
    scope_check: "UNKNOWN",
    validation_fresh: false,
  });
});

test("classifyBaselineDecision: maps worker delegations, retries, and returns null for non-learned routes", () => {
  // Low worker
  assert.deepEqual(
    classifyBaselineDecision({}, { kind: "worker", effort: "low", tier: "flash_lite" }),
    { decisionType: "WORKER_TIER", chosenAction: "FLASH_LOW" },
  );
  assert.deepEqual(
    classifyBaselineDecision({}, { kind: "worker", profile: "flash-low-worker" }),
    { decisionType: "WORKER_TIER", chosenAction: "FLASH_LOW" },
  );

  // Medium worker
  assert.deepEqual(
    classifyBaselineDecision({}, { kind: "worker", effort: "medium", tier: "flash" }),
    { decisionType: "WORKER_TIER", chosenAction: "FLASH_MEDIUM" },
  );
  assert.deepEqual(
    classifyBaselineDecision({}, { kind: "worker", profile: "flash-medium-worker" }),
    { decisionType: "WORKER_TIER", chosenAction: "FLASH_MEDIUM" },
  );

  // High worker
  assert.deepEqual(
    classifyBaselineDecision({}, { kind: "worker", effort: "high", tier: "pro" }),
    { decisionType: "WORKER_TIER", chosenAction: "FLASH_HIGH" },
  );
  assert.deepEqual(
    classifyBaselineDecision({}, { kind: "worker", profile: "flash-worker" }),
    { decisionType: "WORKER_TIER", chosenAction: "FLASH_HIGH" },
  );

  // Direct Action returns null
  assert.equal(
    classifyBaselineDecision({ taskAction: "DIRECT_ACTION" }, { kind: "direct_action", action: "DIRECT_ACTION" }),
    null,
  );

  // CRITICAL review / two-key review returns null
  assert.equal(
    classifyBaselineDecision(
      { criticality: "CRITICAL" },
      { kind: "two-key-review", modelReviewerA: "gemini-3.8-flash-high", modelReviewerB: "gemini-3.8-flash-high" },
    ),
    null,
  );

  // Default / Unknown orchestration returns null
  assert.equal(
    classifyBaselineDecision({}, { kind: "orchestration", reason: "default-orchestration" }),
    null,
  );

  // Retry active mapping
  assert.deepEqual(
    classifyBaselineDecision(
      { retry: true, retry_reason: "FAILED_TEST" },
      { kind: "worker", effort: "medium", retry: true },
    ),
    { decisionType: "RETRY_ACTION", chosenAction: "RETRY_SAME" },
  );

  // Retry active with escalate
  assert.deepEqual(
    classifyBaselineDecision(
      { retry: true, retry_reason: "FAILED_TEST", escalate: true },
      { kind: "worker", effort: "high", retry: true },
    ),
    { decisionType: "RETRY_ACTION", chosenAction: "ESCALATE_WORKER" },
  );

  // Retry with budget exhausted returns null
  assert.equal(
    classifyBaselineDecision(
      { retry: true, retry_reason: "FAILED_TEST" },
      { kind: "orchestration", reason: "retry-budget-exhausted", state: "HUMAN_GATE" },
    ),
    null,
  );
});

test("dreamCorrelationKey builds deterministic safe filesystem key string", () => {
  const key1 = dreamCorrelationKey({
    conversationId: "conv/123:test",
    stepIdx: 5,
    toolCallId: "call_abc?def",
    branchOrdinal: 1,
  });
  assert.equal(key1, "dec-conv%2F123%3Atest_5_call_abc%3Fdef_1");

  // Defaults branchOrdinal to 0
  const key2 = dreamCorrelationKey({
    conversationId: "conv-123",
    stepIdx: 0,
    toolCallId: "call-1",
  });
  assert.equal(key2, "dec-conv-123_0_call-1_0");
});

test("recordDecision and recordDecisionOutcome: full lifecycle, ordering, correlation, and hashes", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-recorder-test-"));
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const telemetryPath = join(tempDir, ".agents", "telemetry", "events.jsonl");
  const pendingDir = join(tempDir, ".agents", "state", "dream", "pending-decisions");

  const correlationKey = dreamCorrelationKey({
    conversationId: "conv-lifecycle-1",
    stepIdx: 1,
    toolCallId: "call-step-1",
    branchOrdinal: 0,
  });

  const mockSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const decisionInput = {
    snapshot_id: mockSnapshotId,
    decision_type: "WORKER_TIER",
    state: { task_action: "IMPLEMENT", complexity: "NORMAL", criticality: "NORMAL" },
    available_actions: ["FLASH_MEDIUM", "FLASH_HIGH"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    conversation_id: "conv-lifecycle-1",
    step_idx: 1,
    tool_call_id: "call-step-1",
    branch_ordinal: 0,
  };

  // 1. Record decision
  const decResult = recordDecision({
    repoRoot: tempDir,
    telemetryPath,
    pendingDir,
    decision: decisionInput,
    correlationKey,
  });

  assert.equal(decResult.recorded, true);
  assert.match(decResult.decision_id, /^dec-/);
  assert.match(decResult.event_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(decResult.correlationKey, correlationKey);

  // 2. Pending decision file exists with factual metadata
  const pendingCheck = getPendingDecision({ pendingDir, correlationKey });
  assert.equal(pendingCheck.ok, true);
  assert.equal(pendingCheck.pending.decision_id, decResult.decision_id);
  assert.equal(pendingCheck.pending.snapshot_id, mockSnapshotId);
  assert.equal(pendingCheck.pending.decision_type, "WORKER_TIER");
  assert.equal(pendingCheck.pending.chosen_action, "FLASH_MEDIUM");
  assert.equal(pendingCheck.pending.conversation_id, "conv-lifecycle-1");
  assert.equal(pendingCheck.pending.step_idx, 1);
  assert.equal(pendingCheck.pending.tool_call_id, "call-step-1");
  assert.equal(pendingCheck.pending.branch_ordinal, 0);
  assert.equal(pendingCheck.pending.event_hash, decResult.event_hash);

  // 3. Record outcome
  const outcomeInput = {
    result: "SUCCESS",
    resulting_snapshot_id: mockSnapshotId,
    evidence_summary: { tests: "PASS", validation_fresh: true },
    retry_state: { attempt: 1, retry_remaining: 1 },
    cost_metrics: { model_calls: 1, latency_ms: 500 },
    terminal_state: "ACCEPTED",
  };

  const outcomeResult = recordDecisionOutcome({
    repoRoot: tempDir,
    telemetryPath,
    pendingDir,
    correlationKey,
    outcome: outcomeInput,
  });

  assert.equal(outcomeResult.recorded, true);
  assert.equal(outcomeResult.decision_id, decResult.decision_id);
  assert.match(outcomeResult.observation_id, /^obs-/);
  assert.match(outcomeResult.event_hash, /^sha256:[a-f0-9]{64}$/);

  // 4. Verify telemetry events.jsonl ordering and hashes
  const lines = readFileSync(telemetryPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);

  const event0 = JSON.parse(lines[0]);
  const event1 = JSON.parse(lines[1]);

  assert.equal(event0.type, "DECISION");
  assert.equal(event1.type, "DECISION_OUTCOME");
  assert.equal(event1.decision_id, event0.decision_id);
  assert.equal(event0.decision_id, decResult.decision_id);
  assert.equal(event0.event_hash, decResult.event_hash);
  assert.equal(event1.event_hash, outcomeResult.event_hash);

  // Event hashes correctly verify against recomputation
  const expectedHash0 = createDreamEvent("DECISION", event0).event_hash;
  assert.equal(event0.event_hash, expectedHash0);

  const expectedHash1 = createDreamEvent("DECISION_OUTCOME", event1).event_hash;
  assert.equal(event1.event_hash, expectedHash1);
});

test("recordDecisionOutcome idempotency: second call returns OUTCOME_ALREADY_RECORDED and does not duplicate", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-recorder-idempotency-"));
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const telemetryPath = join(tempDir, ".agents", "telemetry", "events.jsonl");
  const pendingDir = join(tempDir, ".agents", "state", "dream", "pending-decisions");
  const correlationKey = "dec-idempotency-key";

  const decResult = recordDecision({
    repoRoot: tempDir,
    telemetryPath,
    pendingDir,
    correlationKey,
    decision: {
      snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      decision_type: "INVESTIGATION_STRATEGY",
      state: { task_action: "IMPLEMENT", complexity: "NORMAL", criticality: "NORMAL" },
      available_actions: ["IMPLEMENT_DIRECT", "INVESTIGATE_FIRST"],
      chosen_action: "IMPLEMENT_DIRECT",
      policy_source: "STATIC_ROUTING_CURRENT",
      actor_identity: "ORCHESTRATOR",
    },
  });
  assert.equal(decResult.recorded, true);

  const outcomeInput = {
    result: "SUCCESS",
    evidence_summary: { tests: "PASS" },
    retry_state: { attempt: 1, retry_remaining: 0 },
    cost_metrics: { model_calls: 1 },
    terminal_state: "ACCEPTED",
  };

  // First outcome call: succeeds
  const firstOutcome = recordDecisionOutcome({
    repoRoot: tempDir,
    telemetryPath,
    pendingDir,
    correlationKey,
    outcome: outcomeInput,
  });
  assert.equal(firstOutcome.recorded, true);

  // Second outcome call with same correlationKey: must return OUTCOME_ALREADY_RECORDED
  const secondOutcome = recordDecisionOutcome({
    repoRoot: tempDir,
    telemetryPath,
    pendingDir,
    correlationKey,
    outcome: outcomeInput,
  });
  assert.equal(secondOutcome.recorded, false);
  assert.equal(secondOutcome.reason, "OUTCOME_ALREADY_RECORDED");

  // Verify telemetry file STILL has exactly 2 lines (DECISION + 1 DECISION_OUTCOME)
  const lines = readFileSync(telemetryPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
});

test("recordDecisionOutcome returns PENDING_DECISION_NOT_FOUND when correlation missing", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-recorder-notfound-"));
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const res = recordDecisionOutcome({
    repoRoot: tempDir,
    correlationKey: "dec-nonexistent-key",
    outcome: {
      result: "SUCCESS",
      evidence_summary: {},
      retry_state: {},
      cost_metrics: {},
    },
  });
  assert.equal(res.recorded, false);
  assert.equal(res.reason, "PENDING_DECISION_NOT_FOUND");
});

test("recordDecision and recordDecisionOutcome fail-open semantics: no throw on I/O or validation failures", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-failopen-test-"));
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Create an unwritable telemetry target by making a directory where a file is expected
  const badTelemetryPath = join(tempDir, "unwritable-dir");
  mkdirSync(badTelemetryPath, { recursive: true });

  const validDecision = {
    snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
  };

  // 1. Unwritable telemetry does not throw in recordDecision
  const failDec = recordDecision({
    repoRoot: tempDir,
    telemetryPath: badTelemetryPath, // attempting to append to a directory will fail
    decision: validDecision,
    correlationKey: "dec-fail-key",
  });
  assert.equal(failDec.recorded, false);
  assert.equal(failDec.reason, "DREAM_TELEMETRY_WRITE_FAILED");
  assert.ok(failDec.error_code);

  // 2. Validation failure in recordDecision does not throw
  const invalidDec = recordDecision({
    repoRoot: tempDir,
    decision: { chosen_action: "INVALID" }, // missing required fields
    correlationKey: "dec-invalid-key",
  });
  assert.equal(invalidDec.recorded, false);
  assert.equal(invalidDec.reason, "VALIDATION_FAILED");
  assert.ok(Array.isArray(invalidDec.details));

  // 3. Normal recordDecision to set up pending decision for outcome tests
  const telemetryPath = join(tempDir, "events.jsonl");
  const pendingDir = join(tempDir, "pending");
  const recOk = recordDecision({
    repoRoot: tempDir,
    telemetryPath,
    pendingDir,
    decision: validDecision,
    correlationKey: "dec-ok-key",
  });
  assert.equal(recOk.recorded, true);

  // 4. Unwritable telemetry does not throw in recordDecisionOutcome
  const failOutcome = recordDecisionOutcome({
    repoRoot: tempDir,
    telemetryPath: badTelemetryPath, // directory
    pendingDir,
    correlationKey: "dec-ok-key",
    outcome: {
      result: "SUCCESS",
      evidence_summary: {},
      retry_state: {},
      cost_metrics: {},
    },
  });
  assert.equal(failOutcome.recorded, false);
  assert.equal(failOutcome.reason, "DREAM_TELEMETRY_WRITE_FAILED");

  // 5. Validation failure in recordDecisionOutcome does not throw
  const invalidOutcome = recordDecisionOutcome({
    repoRoot: tempDir,
    telemetryPath,
    pendingDir,
    correlationKey: "dec-ok-key",
    outcome: {
      terminal_state: "INVALID_STATE", // invalid enum
    },
  });
  assert.equal(invalidOutcome.recorded, false);
  assert.equal(invalidOutcome.reason, "VALIDATION_FAILED");

  // 6. Decision ID mismatch in recordDecisionOutcome does not throw
  const mismatchOutcome = recordDecisionOutcome({
    repoRoot: tempDir,
    telemetryPath,
    pendingDir,
    correlationKey: "dec-ok-key",
    outcome: {
      decision_id: "dec-mismatched-id",
      result: "SUCCESS",
      evidence_summary: {},
      retry_state: {},
      cost_metrics: {},
    },
  });
  assert.equal(mismatchOutcome.recorded, false);
  assert.ok(["DECISION_ID_MISMATCH", "VALIDATION_FAILED"].includes(mismatchOutcome.reason));
});

test("recordDecisionOutcome validates factual fields without subjective quality fields or authority escalation", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-factual-test-"));
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const telemetryPath = join(tempDir, "events.jsonl");
  const pendingDir = join(tempDir, "pending");

  recordDecision({
    repoRoot: tempDir,
    telemetryPath,
    pendingDir,
    correlationKey: "dec-factual-key",
    decision: {
      snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      decision_type: "WORKER_TIER",
      state: {},
      available_actions: ["FLASH_MEDIUM"],
      chosen_action: "FLASH_MEDIUM",
      policy_source: "STATIC_ROUTING_CURRENT",
      actor_identity: "ORCHESTRATOR",
    },
  });

  // Rejects forbidden authority fields in outcome
  const rejectedEscalation = recordDecisionOutcome({
    repoRoot: tempDir,
    telemetryPath,
    pendingDir,
    correlationKey: "dec-factual-key",
    outcome: {
      result: "SUCCESS",
      evidence_summary: {},
      retry_state: {},
      cost_metrics: {},
      override_governance: true, // Forbidden authority field
    },
  });
  assert.equal(rejectedEscalation.recorded, false);
  assert.equal(rejectedEscalation.reason, "VALIDATION_FAILED");
});
