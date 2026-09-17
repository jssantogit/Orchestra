import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decideRoute } from "../skills/orchestra/routing-policy.mjs";
import { canonicalize, sha256Canonical } from "./canonical.mjs";
import {
  DREAM_SCHEMAS,
  createDreamEvent,
  validateDreamRecord,
} from "./records.mjs";
import {
  DECISION_TYPES,
  deriveAvailableActions,
  deriveDecisionState,
  classifyBaselineDecision,
  deriveValidatedStaticBaseline,
} from "./action-space.mjs";
import {
  dreamCorrelationKey,
  recordDecision,
} from "./decision-recorder.mjs";
import {
  getPendingDecision,
  recordDecisionOutcome,
} from "./outcome-recorder.mjs";
import {
  sealWorld,
  validateWorld,
  writeSealedWorld,
} from "./world-sealer.mjs";
import {
  BRANCH_STATUS,
  buildDiscoveryTree,
} from "./discovery-tree-builder.mjs";
import {
  REPLAY_STATUS,
  replayExact,
} from "./replay-simulator.mjs";
import {
  COMPARISON_RELATION,
  EVALUATION_DIMENSION,
  evaluateTrajectory,
  compareTrajectoryFacts,
  createReplayReport,
} from "./evaluator.mjs";
import {
  POLICY_STATUS,
  MAX_POLICY_RULES,
  MAX_POLICY_BYTES,
  computePolicyId,
  validatePolicy,
  evaluatePolicy,
} from "./policy-engine.mjs";

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
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from "node:fs";
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

test("recordDecision rejects duplicate live correlation without duplicating telemetry", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-recorder-duplicate-correlation-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const telemetryPath = join(tempDir, "events.jsonl");
  const pendingDir = join(tempDir, "pending");
  const correlationKey = "corr-duplicate-live";
  const decision = {
    snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_POLICY_V1",
    actor_identity: "ORCHESTRATOR",
  };

  const first = recordDecision({ telemetryPath, pendingDir, correlationKey, decision });
  assert.equal(first.recorded, true);

  const second = recordDecision({ telemetryPath, pendingDir, correlationKey, decision });
  assert.equal(second.recorded, false);
  assert.equal(second.reason, "DECISION_ALREADY_PENDING");
  assert.equal(second.error_code, "ERR_CORRELATION_ALREADY_PENDING");

  const events = readFileSync(telemetryPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(events.filter(e => e.type === "DECISION").length, 1);
  assert.equal(readdirSync(pendingDir).filter(name => name.endsWith(".json")).length, 1);
});

test("recordDecision does not publish DECISION when pending persistence fails", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-recorder-pending-failure-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const telemetryPath = join(tempDir, "events.jsonl");
  const badPendingDir = join(tempDir, "pending-is-a-file");
  writeFileSync(badPendingDir, "not-a-directory", "utf8");

  const result = recordDecision({
    telemetryPath,
    pendingDir: badPendingDir,
    correlationKey: "corr-pending-failure",
    decision: {
      snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      decision_type: "WORKER_TIER",
      state: {},
      available_actions: ["FLASH_MEDIUM"],
      chosen_action: "FLASH_MEDIUM",
      policy_source: "STATIC_POLICY_V1",
      actor_identity: "ORCHESTRATOR",
    },
  });

  assert.equal(result.recorded, false);
  assert.equal(result.reason, "DREAM_TELEMETRY_WRITE_FAILED");
  assert.equal(existsSync(telemetryPath), false, "Telemetry must not publish a DECISION without durable correlation state");
});

test("recordDecisionOutcome recovers append-before-consume crash without duplicate event", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-outcome-recovery-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const telemetryPath = join(tempDir, "events.jsonl");
  const pendingDir = join(tempDir, "pending");
  const correlationKey = "corr-outcome-recovery";

  const decision = recordDecision({
    telemetryPath,
    pendingDir,
    correlationKey,
    decision: {
      snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      decision_type: "WORKER_TIER",
      state: {},
      available_actions: ["FLASH_MEDIUM"],
      chosen_action: "FLASH_MEDIUM",
      policy_source: "STATIC_POLICY_V1",
      actor_identity: "ORCHESTRATOR",
    },
  });
  assert.equal(decision.recorded, true);

  const simulatedOutcome = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: decision.decision_id,
    observation_id: "obs-recovery-existing",
    result: "COMPLETED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    terminal_state: "UNKNOWN",
    created_at: "2026-09-17T23:59:00.000Z",
  });
  appendFileSync(telemetryPath, JSON.stringify(simulatedOutcome) + "\n", "utf8");

  const before = readFileSync(telemetryPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(before.length, 2);
  assert.equal(existsSync(join(pendingDir, correlationKey + ".json")), true);

  const recovered = recordDecisionOutcome({
    telemetryPath,
    pendingDir,
    correlationKey,
    outcome: {
      result: "SHOULD_NOT_BE_APPENDED",
      evidence_summary: {},
      retry_state: {},
      cost_metrics: {},
    },
  });

  assert.equal(recovered.recorded, false);
  assert.equal(recovered.reason, "OUTCOME_ALREADY_RECORDED");
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.observation_id, "obs-recovery-existing");

  const after = readFileSync(telemetryPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(after.length, 2, "Recovery must not append a duplicate DECISION_OUTCOME");
  assert.equal(existsSync(join(pendingDir, correlationKey + ".json")), false);
  assert.equal(existsSync(join(pendingDir, correlationKey + ".consumed")), true);
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

test("Task 5 hook integration: record-only hook integration without routing authority", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-hook-int-"));
  t.after(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  const stateDir = join(tempDir, ".agents", "state");
  const dreamPendingDir = join(stateDir, "dream", "pending-decisions");
  const telemetryPath = join(tempDir, ".agents", "telemetry", "events.jsonl");
  mkdirSync(stateDir, { recursive: true });

  const activeState = {
    activeRole: "ORCHESTRATOR",
    taskAction: "IMPLEMENT",
    taskDomain: "CODE",
    complexity: "NORMAL",
  };
  writeFileSync(join(stateDir, "active-state.json"), JSON.stringify(activeState, null, 2), "utf8");

  const preToolScript = resolve(__dirname, "../hooks/pre-tool-enforce.mjs");
  const postToolScript = resolve(__dirname, "../hooks/post-tool-telemetry.mjs");
  const stopToolScript = resolve(__dirname, "../hooks/stop-guard.mjs");

  const toolCall = {
    id: "call_worker_delegation_1",
    name: "invoke_subagent",
    args: {
      Subagents: [
        {
          TypeName: "flash-medium-worker",
          Role: "worker",
          Prompt: "Implement feature X in src/app.ts. allowedPaths: [src/**]",
        },
      ],
    },
  };

  // 1. Pre-tool execution: records pre-action DECISION
  const preInput = JSON.stringify({
    workspacePaths: [tempDir],
    conversationId: "conv-dream-5",
    stepIdx: 1,
    toolCall,
  });

  const preRaw = execFileSync("node", [preToolScript], { input: preInput, encoding: "utf8" });
  const preRes = JSON.parse(preRaw.trim());
  assert.equal(preRes.decision, "allow");
  assert.equal(preRes.overwrite, undefined, "Output must be byte-compatible without overwrite");

  // Verify DECISION record in events.jsonl
  assert(existsSync(telemetryPath), "Telemetry file must exist");
  const preEvents = readFileSync(telemetryPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const decEvents = preEvents.filter(e => e.type === "DECISION");
  assert.equal(decEvents.length, 1);
  const dec = decEvents[0];
  assert.equal(dec.policy_source, "STATIC_POLICY_V1");
  assert.equal(dec.chosen_action, "FLASH_MEDIUM");
  assert.equal(dec.decision_type, "WORKER_TIER");
  assert(dec.available_actions.includes("FLASH_MEDIUM"));

  // 2. Post-tool execution is only dispatch ACK: outcome remains pending.
  const postInput = JSON.stringify({
    workspacePaths: [tempDir],
    conversationId: "conv-dream-5",
    stepIdx: 1,
    toolName: "invoke_subagent",
    toolCall,
    toolResult: "SUCCESS",
  });

  const postRaw = execFileSync("node", [postToolScript], { input: postInput, encoding: "utf8" });
  const postRes = JSON.parse(postRaw.trim());
  assert.deepEqual(postRes, {});

  const ackEvents = readFileSync(telemetryPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(ackEvents.filter(e => e.type === "DECISION_OUTCOME").length, 0, "Dispatch ACK must not close WORKER_TIER outcome");
  assert.equal(readdirSync(dreamPendingDir).filter(f => f.endsWith(".json")).length, 1, "Pending decision must remain open after ACK");

  // 3. Bind factual worker child to the decision correlation and emit terminal child Stop.
  const roleBindingsPath = join(stateDir, "role-bindings.json");
  const roleBindings = JSON.parse(readFileSync(roleBindingsPath, "utf8"));
  const pendingBinding = roleBindings.pendingSubagents.find(p => !p.consumed);
  assert.ok(pendingBinding?.decisionCorrelationKey, "Pending worker binding must carry decision correlation");
  roleBindings.bindings = roleBindings.bindings || {};
  roleBindings.conversations = roleBindings.conversations || {};
  const childBinding = {
    conversationId: "worker-child-5",
    role: "WORKER",
    profile: pendingBinding.profile,
    model: pendingBinding.model,
    parentConversationId: "conv-dream-5",
    originToolCallId: pendingBinding.originToolCallId,
    delegationKind: "WORK",
    decisionCorrelationKey: pendingBinding.decisionCorrelationKey,
    decisionType: pendingBinding.decisionType,
    decisionBranchOrdinal: pendingBinding.decisionBranchOrdinal,
    confidence: "HIGH",
    source: "RUNTIME_IDENTITY",
    consumed: true,
  };
  roleBindings.bindings["worker-child-5"] = childBinding;
  roleBindings.conversations["worker-child-5"] = childBinding;
  writeFileSync(roleBindingsPath, JSON.stringify(roleBindings, null, 2), "utf8");

  execFileSync("node", [stopToolScript], {
    input: JSON.stringify({
      workspacePaths: [tempDir],
      conversationId: "worker-child-5",
      fullyIdle: true,
      terminationReason: "end_turn",
    }),
    encoding: "utf8",
  });

  // Verify DECISION_OUTCOME is produced only at factual child completion.
  const postEvents = readFileSync(telemetryPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const outcomeEvents = postEvents.filter(e => e.type === "DECISION_OUTCOME");
  assert.equal(outcomeEvents.length, 1);
  const out = outcomeEvents[0];
  assert.equal(out.decision_id, dec.decision_id);
  assert.equal(out.result.status, "COMPLETED");
  assert.equal(out.result.child_conversation_id, "worker-child-5");
  assert.equal(out.terminal_state, "UNKNOWN");
  assert(out.observation_id && out.observation_id.startsWith("obs-"));
  assert(out.event_hash && out.event_hash.startsWith("sha256:"));

  const remainingPending = readdirSync(dreamPendingDir).filter(f => f.endsWith(".json"));
  assert.equal(remainingPending.length, 0);
});

test("Task 6: valid decision + correlated outcome + factual actor => SEALED with valid world_manifest_hash", () => {
  const rootSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

  const decEvent = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-t6-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { task_action: "IMPLEMENT", complexity: "NORMAL", criticality: "NORMAL" },
    available_actions: ["FLASH_MEDIUM", "FLASH_HIGH"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });

  const outcomeEvent = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-t6-1",
    observation_id: "obs-t6-1",
    result: "SUCCESS",
    evidence_summary: { tests: "NOT_REQUIRED" },
    retry_state: { attempt: 1, retry_remaining: 1 },
    cost_metrics: { model_calls: 1, latency_ms: 200 },
    terminal_state: "ACCEPTED",
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const res = sealWorld({
    events: [decEvent, outcomeEvent],
    expectedRuntimeFingerprint: runtimeFp,
  });

  assert.equal(res.status, "SEALED");
  assert.equal(res.errors.length, 0);
  assert.ok(res.world);

  const world = res.world;
  assert.equal(world.schema, DREAM_SCHEMAS.WORLD);
  assert.match(world.world_id, /^world-[0-9a-f]{16}$/);
  assert.equal(world.root_snapshot_id, rootSnapshotId);
  assert.equal(world.runtime_fingerprint, runtimeFp);
  assert.deepEqual(world.event_hashes, [decEvent.event_hash, outcomeEvent.event_hash]);

  const expectedManifestHash = sha256Canonical({
    schema: DREAM_SCHEMAS.WORLD,
    root_snapshot_id: rootSnapshotId,
    runtime_fingerprint: runtimeFp,
    event_hashes: [decEvent.event_hash, outcomeEvent.event_hash],
  });
  assert.equal(world.world_manifest_hash, expectedManifestHash);
  assert.equal(world.status, "SEALED");

  // validateWorld verifies integrity
  const valRes = validateWorld(world);
  assert.equal(valRes.valid, true);
  assert.deepEqual(valRes.errors, []);
});

test("Task 6: open decision without outcome => WORLD_INCOMPLETE", () => {
  const rootSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

  const decEvent = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-open-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });

  const res = sealWorld({
    events: [decEvent],
    expectedRuntimeFingerprint: runtimeFp,
  });

  assert.equal(res.status, "WORLD_INCOMPLETE");
  assert.ok(res.errors.includes("OPEN_DECISION_WITHOUT_OUTCOME"));
  assert.equal(res.world, undefined);
});

test("Task 6: mismatched decision_id or orphan outcome => WORLD_INVALID", () => {
  const rootSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

  const decEvent = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-matched-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });

  const orphanOutcome = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-mismatched-99",
    observation_id: "obs-orphan-1",
    result: "SUCCESS",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const res = sealWorld({
    events: [decEvent, orphanOutcome],
    expectedRuntimeFingerprint: runtimeFp,
  });

  assert.equal(res.status, "WORLD_INVALID");
  assert.ok(res.errors.includes("ORPHAN_OR_MISMATCHED_OUTCOME"));
});

test("Task 6: tampered event_hash in decision or outcome => WORLD_INVALID", () => {
  const rootSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

  const decEvent = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-tamper-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });

  const outcomeEvent = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-tamper-1",
    observation_id: "obs-tamper-1",
    result: "SUCCESS",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:05.000Z",
  });

  // Tampered decision event_hash
  const tamperedDec = { ...decEvent, event_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
  const res1 = sealWorld({
    events: [tamperedDec, outcomeEvent],
    expectedRuntimeFingerprint: runtimeFp,
  });
  assert.equal(res1.status, "WORLD_INVALID");
  assert.ok(res1.errors.some(e => e.includes("TAMPERED_EVENT_HASH") || e.includes("EVENT_HASH_MISMATCH")));

  // Tampered outcome payload without updating hash
  const tamperedOutcome = { ...outcomeEvent, result: "TAMPERED_RESULT" };
  const res2 = sealWorld({
    events: [decEvent, tamperedOutcome],
    expectedRuntimeFingerprint: runtimeFp,
  });
  assert.equal(res2.status, "WORLD_INVALID");
  assert.ok(res2.errors.some(e => e.includes("TAMPERED_EVENT_HASH") || e.includes("EVENT_HASH_MISMATCH")));
});

test("Task 6: UNKNOWN or unresolved actor identity => WORLD_INVALID with ROLE_IDENTITY_UNRESOLVED", () => {
  const rootSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

  const unresolvedActors = [
    "UNKNOWN",
    "UNRESOLVED",
    { role: "UNKNOWN", confidence: "HIGH" },
    { role: "WORKER_MEDIUM", confidence: "LOW" },
    { role: "WORKER_MEDIUM", resolved: false },
  ];

  for (const actor of unresolvedActors) {
    const decEvent = createDreamEvent("DECISION", {
      schema: DREAM_SCHEMAS.DECISION,
      decision_id: "dec-actor-test",
      snapshot_id: rootSnapshotId,
      decision_type: "WORKER_TIER",
      state: {},
      available_actions: ["FLASH_MEDIUM"],
      chosen_action: "FLASH_MEDIUM",
      policy_source: "STATIC_ROUTING_CURRENT",
      actor_identity: actor,
      step_idx: 1,
      created_at: "2026-09-17T12:00:00.000Z",
    });

    const outcomeEvent = createDreamEvent("DECISION_OUTCOME", {
      schema: DREAM_SCHEMAS.OUTCOME,
      decision_id: "dec-actor-test",
      observation_id: "obs-actor-test",
      result: "SUCCESS",
      evidence_summary: {},
      retry_state: {},
      cost_metrics: {},
      created_at: "2026-09-17T12:00:05.000Z",
    });

    const res = sealWorld({
      events: [decEvent, outcomeEvent],
      expectedRuntimeFingerprint: runtimeFp,
    });

    assert.equal(res.status, "WORLD_INVALID", `Actor ${JSON.stringify(actor)} must yield WORLD_INVALID`);
    assert.ok(res.errors.includes("ROLE_IDENTITY_UNRESOLVED"));
  }
});

test("Task 6: evidence references validation and absent execution provenance", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-sealer-evidence-"));
  t.after(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  const rootSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

  const decEvent = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-ev-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });

  // 1. Evidence requires verification (tests: PASS) but evidence_provenance is empty -> WORLD_INVALID
  const outcomeMissingEv = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-ev-1",
    observation_id: "obs-ev-1",
    result: "SUCCESS",
    evidence_summary: { tests: "PASS", validation_fresh: true },
    retry_state: {},
    cost_metrics: {},
    evidence_provenance: [],
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const resMissing = sealWorld({
    events: [decEvent, outcomeMissingEv],
    expectedRuntimeFingerprint: runtimeFp,
    repoRoot: tempDir,
  });
  assert.equal(resMissing.status, "WORLD_INVALID");
  assert.ok(resMissing.errors.some(e => e.includes("EVIDENCE") || e.includes("PROVENANCE")));

  // 2. Evidence references absent execution ID -> WORLD_INVALID
  const outcomeAbsentExec = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-ev-1",
    observation_id: "obs-ev-2",
    result: "SUCCESS",
    evidence_summary: { tests: "PASS", validation_fresh: true },
    retry_state: {},
    cost_metrics: {},
    evidence_provenance: ["exec-absent-999"],
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const resAbsent = sealWorld({
    events: [decEvent, outcomeAbsentExec],
    expectedRuntimeFingerprint: runtimeFp,
    repoRoot: tempDir,
  });
  assert.equal(resAbsent.status, "WORLD_INVALID");
  assert.ok(resAbsent.errors.some(e => e.includes("EVIDENCE") || e.includes("EXECUTION") || e.includes("ABSENT")));

  // 3. Evidence references present execution ID on disk -> SEALED
  const execDir = join(tempDir, ".agents", "state", "executions");
  mkdirSync(execDir, { recursive: true });
  writeFileSync(join(execDir, "exec-present-1.json"), JSON.stringify({ executionId: "exec-present-1", status: "PASS" }), "utf8");

  const outcomePresentExec = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-ev-1",
    observation_id: "obs-ev-3",
    result: "SUCCESS",
    evidence_summary: { tests: "PASS", validation_fresh: true },
    retry_state: {},
    cost_metrics: {},
    evidence_provenance: ["exec-present-1"],
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const resPresent = sealWorld({
    events: [decEvent, outcomePresentExec],
    expectedRuntimeFingerprint: runtimeFp,
    repoRoot: tempDir,
  });
  assert.equal(resPresent.status, "SEALED");
  assert.equal(resPresent.errors.length, 0);
});

test("Task 6: writeSealedWorld writes only sealed worlds and rejects incomplete/invalid worlds", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "dream-sealer-write-"));
  t.after(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // 1. Incomplete world cannot be written
  const incompleteWorld = {
    schema: DREAM_SCHEMAS.WORLD,
    world_id: "world-incomplete-1",
    status: "WORLD_INCOMPLETE",
  };
  const writeInc = writeSealedWorld(tempDir, incompleteWorld);
  assert.equal(writeInc.written, false);

  // 2. Invalid world cannot be written
  const invalidWorld = {
    schema: DREAM_SCHEMAS.WORLD,
    world_id: "world-invalid-1",
    status: "WORLD_INVALID",
  };
  const writeInv = writeSealedWorld(tempDir, invalidWorld);
  assert.equal(writeInv.written, false);

  // 3. World with tampered manifest hash cannot be written
  const tamperedWorld = {
    schema: DREAM_SCHEMAS.WORLD,
    world_id: "world-tampered-1",
    root_snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    runtime_fingerprint: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    event_hashes: ["sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
    world_manifest_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    status: "SEALED",
    created_at: "2026-09-17T12:00:00.000Z",
  };
  const writeTamp = writeSealedWorld(tempDir, tamperedWorld);
  assert.equal(writeTamp.written, false);

  // 4. Valid sealed world written under .agents/dream-data/worlds/${world.world_id}.json
  const rootSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
  const decEvent = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-w-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const outEvent = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-w-1",
    observation_id: "obs-w-1",
    result: "SUCCESS",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const sealRes = sealWorld({
    events: [decEvent, outEvent],
    expectedRuntimeFingerprint: runtimeFp,
  });
  assert.equal(sealRes.status, "SEALED");

  const writeOk = writeSealedWorld(tempDir, sealRes.world);
  assert.equal(writeOk.written, true);
  assert.equal(writeOk.path, join(tempDir, ".agents", "dream-data", "worlds", `${sealRes.world.world_id}.json`));
  assert.ok(existsSync(writeOk.path));

  const savedWorld = JSON.parse(readFileSync(writeOk.path, "utf8"));
  assert.equal(savedWorld.world_id, sealRes.world.world_id);
  assert.equal(savedWorld.world_manifest_hash, sealRes.world.world_manifest_hash);
  assert.equal(validateWorld(savedWorld).valid, true);
});

test("Task 7: Unobserved legal actions are explicitly retained as UNKNOWN_BRANCH", () => {
  const rootSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const childSnapshotId = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

  const decEvent = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-t7-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { task: "fix-bug" },
    available_actions: ["FLASH_MEDIUM", "FLASH_HIGH"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });

  const outEvent = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-t7-1",
    observation_id: "obs-t7-1",
    result: "SUCCESS",
    resulting_snapshot_id: childSnapshotId,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 150 },
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const sealRes = sealWorld({
    events: [decEvent, outEvent],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  const tree = buildDiscoveryTree(sealRes.world);

  assert.equal(tree.world_id, sealRes.world.world_id);
  assert.equal(tree.root_snapshot_id, rootSnapshotId);

  const rootNode = tree.nodes[rootSnapshotId];
  assert.ok(rootNode, "Root node must be present in discovery tree");
  assert.equal(rootNode.snapshot_id, rootSnapshotId);

  // Assert FLASH_MEDIUM is OBSERVED_ONCE
  const observedAction = rootNode.actions["FLASH_MEDIUM"];
  assert.ok(observedAction);
  assert.equal(observedAction.action, "FLASH_MEDIUM");
  assert.equal(observedAction.status, BRANCH_STATUS.OBSERVED_ONCE);
  assert.equal(observedAction.observations.length, 1);
  assert.deepEqual(observedAction.observations[0], {
    observation_id: "obs-t7-1",
    decision_id: "dec-t7-1",
    result: "SUCCESS",
    resulting_snapshot_id: childSnapshotId,
    terminal_state: "ACCEPTED",
    cost_metrics: { tokens: 150 },
    evidence_summary: {},
  });

  // Assert FLASH_HIGH is UNKNOWN_BRANCH with empty observations
  const unobservedAction = rootNode.actions["FLASH_HIGH"];
  assert.ok(unobservedAction);
  assert.equal(unobservedAction.action, "FLASH_HIGH");
  assert.equal(unobservedAction.status, BRANCH_STATUS.UNKNOWN_BRANCH);
  assert.deepEqual(unobservedAction.observations, []);

  // Assert metadata counts
  assert.equal(tree.metadata.total_nodes, Object.keys(tree.nodes).length);
  assert.equal(tree.metadata.total_observations, 1);
  assert.equal(tree.metadata.unknown_branches, 1);
  assert.equal(tree.metadata.ambiguous_branches, 0);
});

test("Task 7: Multiple observations with same terminal state yield OBSERVED_MULTIPLE_CONSISTENT", () => {
  const rootSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

  // Two decisions at the same snapshot choosing the same action, both ACCEPTED
  const dec1 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-cons-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { attempt: 1 },
    available_actions: ["FLASH_MEDIUM", "PRO"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    branch_ordinal: 0,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const out1 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-cons-1",
    observation_id: "obs-cons-1",
    result: "SUCCESS",
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 100 },
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const dec2 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-cons-2",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { attempt: 2 },
    available_actions: ["FLASH_MEDIUM", "PRO"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 2,
    branch_ordinal: 1,
    created_at: "2026-09-17T12:00:10.000Z",
  });
  const out2 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-cons-2",
    observation_id: "obs-cons-2",
    result: "SUCCESS",
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 110 },
    created_at: "2026-09-17T12:00:15.000Z",
  });

  const sealRes = sealWorld({
    events: [dec1, out1, dec2, out2],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  const tree = buildDiscoveryTree(sealRes.world);
  const actionBranch = tree.nodes[rootSnapshotId].actions["FLASH_MEDIUM"];

  assert.equal(actionBranch.status, BRANCH_STATUS.OBSERVED_MULTIPLE_CONSISTENT);
  assert.equal(actionBranch.observations.length, 2);
  assert.equal(actionBranch.observations[0].observation_id, "obs-cons-1");
  assert.equal(actionBranch.observations[1].observation_id, "obs-cons-2");
  assert.equal(tree.metadata.ambiguous_branches, 0);

  // Also test consistent non-accepted: both FAILED
  const decFail1 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-fail-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_LOW"],
    chosen_action: "FLASH_LOW",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 3,
    created_at: "2026-09-17T12:00:20.000Z",
  });
  const outFail1 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-fail-1",
    observation_id: "obs-fail-1",
    result: "ERROR",
    terminal_state: "FAILED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:25.000Z",
  });
  const decFail2 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-fail-2",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_LOW"],
    chosen_action: "FLASH_LOW",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 4,
    created_at: "2026-09-17T12:00:30.000Z",
  });
  const outFail2 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-fail-2",
    observation_id: "obs-fail-2",
    result: "ERROR",
    terminal_state: "FAILED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:35.000Z",
  });

  const sealResFail = sealWorld({
    events: [decFail1, outFail1, decFail2, outFail2],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealResFail.status, "SEALED");

  const treeFail = buildDiscoveryTree(sealResFail.world);
  const failBranch = treeFail.nodes[rootSnapshotId].actions["FLASH_LOW"];
  assert.equal(failBranch.status, BRANCH_STATUS.OBSERVED_MULTIPLE_CONSISTENT);
  assert.equal(failBranch.observations.length, 2);
});

test("Task 7: Multiple observations with conflicting terminal state yield AMBIGUOUS_OBSERVED", () => {
  const rootSnapshotId = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

  // Decision 1 at S0: ACCEPTED
  const dec1 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-amb-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const out1 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-amb-1",
    observation_id: "obs-amb-1",
    result: "SUCCESS",
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:05.000Z",
  });

  // Decision 2 at S0: FAILED / RETRY_REQUIRED
  const dec2 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-amb-2",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: {},
    available_actions: ["FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 2,
    created_at: "2026-09-17T12:00:10.000Z",
  });
  const out2 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-amb-2",
    observation_id: "obs-amb-2",
    result: "RETRY_NEEDED",
    terminal_state: "RETRY_REQUIRED",
    evidence_summary: {},
    retry_state: { attempt: 1 },
    cost_metrics: {},
    created_at: "2026-09-17T12:00:15.000Z",
  });

  const sealRes = sealWorld({
    events: [dec1, out1, dec2, out2],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  const tree = buildDiscoveryTree(sealRes.world);
  const actionBranch = tree.nodes[rootSnapshotId].actions["FLASH_MEDIUM"];

  assert.equal(actionBranch.status, BRANCH_STATUS.AMBIGUOUS_OBSERVED);
  assert.equal(actionBranch.observations.length, 2);
  assert.equal(tree.metadata.ambiguous_branches, 1);
});

test("Task 7: Tree preserves original causal lineage and resulting_snapshot_id transitions", () => {
  const rootSnapshotId = "sha256:0000000000000000000000000000000000000000000000000000000000000001";
  const step1SnapshotId = "sha256:0000000000000000000000000000000000000000000000000000000000000002";
  const terminalSnapshotId = "sha256:0000000000000000000000000000000000000000000000000000000000000003";
  const runtimeFp = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

  // Step 1: at rootSnapshotId -> transitions to step1SnapshotId
  const dec1 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-seq-1",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "start" },
    available_actions: ["PLAN", "EXECUTE"],
    chosen_action: "PLAN",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const out1 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-seq-1",
    observation_id: "obs-seq-1",
    result: "PLAN_CREATED",
    resulting_snapshot_id: step1SnapshotId,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 50 },
    created_at: "2026-09-17T12:00:05.000Z",
  });

  // Step 2: at step1SnapshotId -> transitions to terminalSnapshotId
  const dec2 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-seq-2",
    parent_decision_id: "dec-seq-1",
    snapshot_id: step1SnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "execution" },
    available_actions: ["EXECUTE_FAST", "EXECUTE_CAREFUL"],
    chosen_action: "EXECUTE_FAST",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "WORKER",
    step_idx: 2,
    created_at: "2026-09-17T12:00:10.000Z",
  });
  const out2 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-seq-2",
    observation_id: "obs-seq-2",
    result: "EXECUTION_COMPLETE",
    resulting_snapshot_id: terminalSnapshotId,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 120 },
    created_at: "2026-09-17T12:00:15.000Z",
  });

  const sealRes = sealWorld({
    events: [dec1, out1, dec2, out2],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  const tree = buildDiscoveryTree(sealRes.world);

  // Lineage validation
  assert.equal(tree.world_id, sealRes.world.world_id);
  assert.equal(tree.root_snapshot_id, rootSnapshotId);

  // Verify transition from root -> step 1
  const rootObs = tree.nodes[rootSnapshotId].actions["PLAN"].observations[0];
  assert.equal(rootObs.decision_id, "dec-seq-1");
  assert.equal(rootObs.resulting_snapshot_id, step1SnapshotId);

  // Verify step 1 node exists and links to terminal snapshot
  const step1Node = tree.nodes[step1SnapshotId];
  assert.ok(step1Node, "Child snapshot node must exist in tree");
  assert.equal(step1Node.snapshot_id, step1SnapshotId);

  const step1Obs = step1Node.actions["EXECUTE_FAST"].observations[0];
  assert.equal(step1Obs.decision_id, "dec-seq-2");
  assert.equal(step1Obs.resulting_snapshot_id, terminalSnapshotId);

  // Verify unobserved actions at each step are preserved as UNKNOWN_BRANCH
  assert.equal(tree.nodes[rootSnapshotId].actions["EXECUTE"].status, BRANCH_STATUS.UNKNOWN_BRANCH);
  assert.equal(tree.nodes[step1SnapshotId].actions["EXECUTE_CAREFUL"].status, BRANCH_STATUS.UNKNOWN_BRANCH);

  // Content-addressed snapshot indexing check (tree.snapshots matches tree.nodes)
  assert.equal(tree.snapshots[rootSnapshotId], tree.nodes[rootSnapshotId]);
  assert.equal(tree.snapshots[step1SnapshotId], tree.nodes[step1SnapshotId]);

  // Terminal node is indexed
  assert.ok(tree.nodes[terminalSnapshotId]);
  assert.equal(tree.nodes[terminalSnapshotId].snapshot_id, terminalSnapshotId);
});

test("Task 7: Rejects unsealed or invalid world input", () => {
  // 1. null / non-object input
  assert.throws(() => buildDiscoveryTree(null), /INVALID_SEALED_WORLD|WORLD_INVALID|must be an object/i);
  assert.throws(() => buildDiscoveryTree(undefined), /INVALID_SEALED_WORLD|WORLD_INVALID|must be an object/i);
  assert.throws(() => buildDiscoveryTree("not-a-world"), /INVALID_SEALED_WORLD|WORLD_INVALID|must be an object/i);

  // 2. Unsealed world
  const unsealedWorld = {
    schema: DREAM_SCHEMAS.WORLD,
    world_id: "world-unsealed-1",
    root_snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    runtime_fingerprint: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    event_hashes: [],
    world_manifest_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    status: "WORLD_INCOMPLETE",
    created_at: "2026-09-17T12:00:00.000Z",
  };
  assert.throws(() => buildDiscoveryTree(unsealedWorld), /INVALID_SEALED_WORLD|WORLD_NOT_SEALED|Invalid world status/i);

  // 3. Tampered manifest hash
  const tamperedWorld = {
    schema: DREAM_SCHEMAS.WORLD,
    world_id: "world-tampered-1",
    root_snapshot_id: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    runtime_fingerprint: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    event_hashes: ["sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
    world_manifest_hash: "sha256:bad0000000000000000000000000000000000000000000000000000000000000",
    status: "SEALED",
    created_at: "2026-09-17T12:00:00.000Z",
  };
  assert.throws(() => buildDiscoveryTree(tamperedWorld), /INVALID_SEALED_WORLD|WORLD_MANIFEST_HASH_MISMATCH/i);
});

test("Task 8: Baseline replay reproducing historical path -> EXACT_REPLAY_COMPLETE", () => {
  const rootSnapshotId = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const step1SnapshotId = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
  const terminalSnapshotId = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
  const runtimeFp = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

  const dec1 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-base-1",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "plan" },
    available_actions: ["PLAN", "EXECUTE"],
    chosen_action: "PLAN",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const out1 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-base-1",
    observation_id: "obs-base-1",
    result: "PLAN_DONE",
    resulting_snapshot_id: step1SnapshotId,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 100, latency_ms: 250 },
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const dec2 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-base-2",
    parent_decision_id: "dec-base-1",
    snapshot_id: step1SnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "execute" },
    available_actions: ["EXECUTE_FAST", "EXECUTE_DEEP"],
    chosen_action: "EXECUTE_FAST",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "WORKER",
    step_idx: 2,
    created_at: "2026-09-17T12:00:10.000Z",
  });
  const out2 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-base-2",
    observation_id: "obs-base-2",
    result: "ALL_SUCCESS",
    resulting_snapshot_id: terminalSnapshotId,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 200, latency_ms: 500 },
    created_at: "2026-09-17T12:00:15.000Z",
  });

  const sealRes = sealWorld({
    events: [dec1, out1, dec2, out2],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  // Replay callback reproduces the historical action at each step
  const historicalActions = {
    [rootSnapshotId]: "PLAN",
    [step1SnapshotId]: "EXECUTE_FAST",
  };
  const calls = [];
  const chooseAction = ({ decisionType, state, availableActions, snapshotId, prefix }) => {
    calls.push({ decisionType, state, availableActions, snapshotId, prefixLength: prefix.length });
    return historicalActions[snapshotId];
  };

  const replayRes = replayExact({ world: sealRes.world, chooseAction });

  assert.equal(replayRes.status, REPLAY_STATUS.EXACT_REPLAY_COMPLETE);
  assert.equal(replayRes.trajectories.length, 1);

  const traj = replayRes.trajectories[0];
  assert.equal(traj.status, REPLAY_STATUS.EXACT_REPLAY_COMPLETE);
  assert.equal(traj.steps.length, 2);
  assert.equal(traj.steps[0].chosen_action, "PLAN");
  assert.equal(traj.steps[0].observation_id, "obs-base-1");
  assert.equal(traj.steps[1].chosen_action, "EXECUTE_FAST");
  assert.equal(traj.steps[1].observation_id, "obs-base-2");
  assert.equal(traj.terminal_state, "ACCEPTED");
  assert.equal(traj.cost_metrics.tokens, 300);
  assert.equal(traj.cost_metrics.latency_ms, 750);

  assert.equal(replayRes.metadata.total_trajectories, 1);
  assert.equal(replayRes.metadata.complete_trajectories, 1);
  assert.equal(replayRes.metadata.unknown_trajectories, 0);
  assert.equal(replayRes.metadata.invalid_policy_trajectories, 0);
  assert.equal(calls.length, 2);
});

test("Task 8: Callback selecting unobserved legal action -> UNKNOWN_BRANCH with zero manufactured outcome", () => {
  const rootSnapshotId = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const runtimeFp = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

  const dec = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-unobserved-1",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "start" },
    available_actions: ["PLAN", "EXECUTE_DIRECT"],
    chosen_action: "PLAN",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const out = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-unobserved-1",
    observation_id: "obs-unobserved-1",
    result: "PLAN_DONE",
    resulting_snapshot_id: null,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 50 },
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const sealRes = sealWorld({
    events: [dec, out],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  // Legal action, but NEVER observed in the factual world
  const chooseAction = ({ availableActions }) => {
    assert.ok(availableActions.includes("EXECUTE_DIRECT"));
    return "EXECUTE_DIRECT";
  };

  const replayRes = replayExact({ world: sealRes.world, chooseAction });

  assert.equal(replayRes.status, REPLAY_STATUS.UNKNOWN_BRANCH);
  assert.equal(replayRes.trajectories.length, 1);
  assert.equal(replayRes.trajectories[0].status, REPLAY_STATUS.UNKNOWN_BRANCH);
  // Zero manufactured outcome
  assert.equal(replayRes.trajectories[0].steps.length, 0);
  assert.equal(replayRes.trajectories[0].terminal_state, null);
  assert.equal(replayRes.metadata.unknown_trajectories, 1);
  assert.equal(replayRes.metadata.complete_trajectories, 0);
  assert.equal(replayRes.metadata.invalid_policy_trajectories, 0);
});

test("Task 8: Callback selecting illegal action -> POLICY_INVALID_ACTION", () => {
  const rootSnapshotId = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const runtimeFp = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

  const dec = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-illegal-1",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "start" },
    available_actions: ["PLAN"],
    chosen_action: "PLAN",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const out = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-illegal-1",
    observation_id: "obs-illegal-1",
    result: "PLAN_DONE",
    resulting_snapshot_id: null,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const sealRes = sealWorld({
    events: [dec, out],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  // Chooses action outside available_actions
  const chooseAction = () => "UNAUTHORIZED_ESCALATION";

  const replayRes = replayExact({ world: sealRes.world, chooseAction });

  assert.equal(replayRes.status, REPLAY_STATUS.POLICY_INVALID_ACTION);
  assert.equal(replayRes.trajectories.length, 1);
  assert.equal(replayRes.trajectories[0].status, REPLAY_STATUS.POLICY_INVALID_ACTION);
  assert.equal(replayRes.trajectories[0].steps.length, 0);
  assert.equal(replayRes.metadata.invalid_policy_trajectories, 1);
  assert.equal(replayRes.metadata.complete_trajectories, 0);
});

test("Task 8: Hindsight trap test: prefix provided to chooseAction contains strictly previous steps and zero future data", () => {
  const rootSnapshotId = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const step1SnapshotId = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
  const step2SnapshotId = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
  const runtimeFp = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

  const FUTURE_SECRET_OBS_ID = "obs-future-secret-winning-id";
  const FUTURE_SECRET_RESULT = "SUPER_SECRET_WINNING_RESULT_VALUE";

  const dec1 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-hindsight-1",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { step: 0 },
    available_actions: ["ACT_0"],
    chosen_action: "ACT_0",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const out1 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-hindsight-1",
    observation_id: "obs-hindsight-1",
    result: "RESULT_0",
    resulting_snapshot_id: step1SnapshotId,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const dec2 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-hindsight-2",
    parent_decision_id: "dec-hindsight-1",
    snapshot_id: step1SnapshotId,
    decision_type: "WORKER_TIER",
    state: { step: 1 },
    available_actions: ["ACT_1"],
    chosen_action: "ACT_1",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 2,
    created_at: "2026-09-17T12:00:10.000Z",
  });
  const out2 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-hindsight-2",
    observation_id: FUTURE_SECRET_OBS_ID,
    result: FUTURE_SECRET_RESULT,
    resulting_snapshot_id: step2SnapshotId,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:15.000Z",
  });

  const sealRes = sealWorld({
    events: [dec1, out1, dec2, out2],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  let step0PrefixSeen = null;
  let step1PrefixSeen = null;

  const chooseAction = ({ snapshotId, prefix }) => {
    const prefixStr = JSON.stringify(prefix);
    // CRITICAL: Future observation ID and future result MUST NEVER appear in prefix
    assert.equal(prefixStr.includes(FUTURE_SECRET_OBS_ID), false, "Future observation ID leaked to policy prefix!");
    assert.equal(prefixStr.includes(FUTURE_SECRET_RESULT), false, "Future result leaked to policy prefix!");

    if (snapshotId === rootSnapshotId) {
      step0PrefixSeen = [...prefix];
      assert.equal(prefix.length, 0, "Prefix at step 0 must be empty");
      return "ACT_0";
    }
    if (snapshotId === step1SnapshotId) {
      step1PrefixSeen = [...prefix];
      assert.equal(prefix.length, 1, "Prefix at step 1 must contain exactly step 0");
      assert.equal(prefix[0].snapshot_id, rootSnapshotId);
      assert.equal(prefix[0].chosen_action, "ACT_0");
      assert.equal(prefix[0].observation_id, "obs-hindsight-1");
      return "ACT_1";
    }
    throw new Error(`Unexpected snapshotId: ${snapshotId}`);
  };

  const replayRes = replayExact({ world: sealRes.world, chooseAction });

  assert.equal(replayRes.status, REPLAY_STATUS.EXACT_REPLAY_COMPLETE);
  assert.ok(step0PrefixSeen !== null);
  assert.ok(step1PrefixSeen !== null);
});

test("Task 8: Multi-observation branching: decision with 2 recorded observations forks into 2 distinct derived trajectories", () => {
  const rootSnapshotId = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const snapBranchA = "sha256:222222222222222222222222222222222222222222222222222222222222222a";
  const snapBranchB = "sha256:222222222222222222222222222222222222222222222222222222222222222b";
  const runtimeFp = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

  // Two runs recorded from rootSnapshotId with the same chosen action "RUN_TEST"
  const decA = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-branch-A",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "test" },
    available_actions: ["RUN_TEST"],
    chosen_action: "RUN_TEST",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const outA = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-branch-A",
    observation_id: "obs-branch-A",
    result: { status: "ACCEPTED", variant: "A" },
    resulting_snapshot_id: snapBranchA,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 100 },
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const decB = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-branch-B",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "test" },
    available_actions: ["RUN_TEST"],
    chosen_action: "RUN_TEST",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:10.000Z",
  });
  const outB = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-branch-B",
    observation_id: "obs-branch-B",
    result: { status: "ACCEPTED", variant: "B" },
    resulting_snapshot_id: snapBranchB,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 120 },
    created_at: "2026-09-17T12:00:15.000Z",
  });

  const sealRes = sealWorld({
    events: [decA, outA, decB, outB],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  const chooseAction = () => "RUN_TEST";

  const replayRes = replayExact({ world: sealRes.world, chooseAction });

  assert.equal(replayRes.status, REPLAY_STATUS.EXACT_REPLAY_COMPLETE);
  assert.equal(replayRes.trajectories.length, 2);
  assert.equal(replayRes.metadata.total_trajectories, 2);
  assert.equal(replayRes.metadata.complete_trajectories, 2);

  const obsIds = replayRes.trajectories.map((t) => t.steps[0].observation_id).sort();
  assert.deepEqual(obsIds, ["obs-branch-A", "obs-branch-B"]);

  const resSnapshots = replayRes.trajectories.map((t) => t.steps[0].resulting_snapshot_id).sort();
  assert.deepEqual(resSnapshots, [snapBranchA, snapBranchB]);
});

test("Task 8: Complexity limit: exceeding maxTrajectories returns REPLAY_COMPLEXITY_LIMIT", () => {
  const rootSnapshotId = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const snapBranchA = "sha256:222222222222222222222222222222222222222222222222222222222222222a";
  const snapBranchB = "sha256:222222222222222222222222222222222222222222222222222222222222222b";
  const runtimeFp = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

  const decA = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-limit-A",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "test" },
    available_actions: ["RUN_TEST"],
    chosen_action: "RUN_TEST",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const outA = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-limit-A",
    observation_id: "obs-limit-A",
    result: "SUCCESS_A",
    resulting_snapshot_id: snapBranchA,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const decB = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-limit-B",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "test" },
    available_actions: ["RUN_TEST"],
    chosen_action: "RUN_TEST",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:10.000Z",
  });
  const outB = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-limit-B",
    observation_id: "obs-limit-B",
    result: "SUCCESS_B",
    resulting_snapshot_id: snapBranchB,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: {},
    created_at: "2026-09-17T12:00:15.000Z",
  });

  const sealRes = sealWorld({
    events: [decA, outA, decB, outB],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  // With maxTrajectories = 1, branching into 2 exceeds limit
  const replayRes = replayExact({
    world: sealRes.world,
    chooseAction: () => "RUN_TEST",
    maxTrajectories: 1,
  });

  assert.equal(replayRes.status, REPLAY_STATUS.REPLAY_COMPLEXITY_LIMIT);
});

test("Task 8: Static test asserting replay-simulator.mjs has zero model-call surface or network/child_process imports", () => {
  const replaySimPath = resolve(__dirname, "replay-simulator.mjs");
  const source = readFileSync(replaySimPath, "utf8");

  // Invariant 1: Zero model calls, SDKs, agent profiles, invoke_subagent
  assert.doesNotMatch(source, /@google\/genai/);
  assert.doesNotMatch(source, /@google\/generative-ai/);
  assert.doesNotMatch(source, /openai/);
  assert.doesNotMatch(source, /anthropic/);
  assert.doesNotMatch(source, /invoke_subagent/);
  assert.doesNotMatch(source, /flash-orchestrator/);
  assert.doesNotMatch(source, /flash-worker/);
  assert.doesNotMatch(source, /luna-/);
  assert.doesNotMatch(source, /terra-/);

  // Invariant 2: Pure deterministic local simulation (no network, no child_process)
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /node:net/);
  assert.doesNotMatch(source, /node:http/);
  assert.doesNotMatch(source, /node:https/);
  assert.doesNotMatch(source, /\bfetch\b/);

  // Allowed imports: only local dream modules
  const importLines = source.match(/import\s+.*?\s+from\s+["'].*?["']/g) || [];
  for (const line of importLines) {
    const match = line.match(/from\s+["'](.*?)["']/);
    assert.ok(match, `Invalid import line: ${line}`);
    const importPath = match[1];
    assert.ok(
      importPath.startsWith("./"),
      `replay-simulator.mjs may only import local modules within dream, got: ${importPath}`
    );
  }
});

test("Task 8: Rejects invalid or unsealed world with WORLD_INVALID", () => {
  const res1 = replayExact({ world: null, chooseAction: () => "ACT" });
  assert.equal(res1.status, REPLAY_STATUS.WORLD_INVALID);
  assert.ok(res1.errors.length > 0);

  const res2 = replayExact({ world: { status: "WORLD_INCOMPLETE" }, chooseAction: () => "ACT" });
  assert.equal(res2.status, REPLAY_STATUS.WORLD_INVALID);
  assert.ok(res2.errors.length > 0);
});

test("Task 9: Hard invalidation triggers mark trajectory as ineligible", () => {
  // 1. Governance violation
  const tGov = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    governance_violation: true,
  };
  const evalGov = evaluateTrajectory(tGov);
  assert.equal(evalGov.eligible, false);
  assert.ok(evalGov.reason.toLowerCase().includes("governance"));

  // 2. Scope violation
  const tScope = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    scope_violation: true,
  };
  const evalScope = evaluateTrajectory(tScope);
  assert.equal(evalScope.eligible, false);
  assert.ok(evalScope.reason.toLowerCase().includes("scope"));

  // 3. Orchestrator product write
  const tOrchWrite = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    orchestrator_product_write: true,
  };
  const evalOrchWrite = evaluateTrajectory(tOrchWrite);
  assert.equal(evalOrchWrite.eligible, false);
  assert.ok(evalOrchWrite.reason.toLowerCase().includes("orchestrator"));

  // 4. Reviewer product write
  const tRevWrite = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    reviewer_product_write: true,
  };
  const evalRevWrite = evaluateTrajectory(tRevWrite);
  assert.equal(evalRevWrite.eligible, false);
  assert.ok(evalRevWrite.reason.toLowerCase().includes("reviewer"));

  // 5. Unattributed mutation
  const tUnattr = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    unattributed_mutation: true,
  };
  const evalUnattr = evaluateTrajectory(tUnattr);
  assert.equal(evalUnattr.eligible, false);
  assert.ok(evalUnattr.reason.toLowerCase().includes("mutation"));

  // 6. Evidence ledger integrity failure
  const tLedger = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    evidence_ledger_integrity_failure: true,
  };
  const evalLedger = evaluateTrajectory(tLedger);
  assert.equal(evalLedger.eligible, false);
  assert.ok(evalLedger.reason.toLowerCase().includes("ledger"));

  // 7. Stale evidence used for acceptance
  const tStale = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    stale_evidence: true,
  };
  const evalStale = evaluateTrajectory(tStale);
  assert.equal(evalStale.eligible, false);
  assert.ok(evalStale.reason.toLowerCase().includes("stale"));

  // 8. Failed tool interpreted as success
  const tFailedTool = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    failed_tool_as_success: true,
  };
  const evalFailedTool = evaluateTrajectory(tFailedTool);
  assert.equal(evalFailedTool.eligible, false);
  assert.ok(evalFailedTool.reason.toLowerCase().includes("tool"));

  // 9. Two-Key bypass
  const tTwoKey = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    two_key_bypass: true,
  };
  const evalTwoKey = evaluateTrajectory(tTwoKey);
  assert.equal(evalTwoKey.eligible, false);
  assert.ok(evalTwoKey.reason.toLowerCase().includes("two-key"));

  // 10. Unresolved Human Gate treated as success
  const tHumanGate = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    unresolved_human_gate: true,
  };
  const evalHumanGate = evaluateTrajectory(tHumanGate);
  assert.equal(evalHumanGate.eligible, false);
  assert.ok(evalHumanGate.reason.toLowerCase().includes("human gate"));

  // 11. Illegal policy action
  const tIllegal = {
    status: REPLAY_STATUS.POLICY_INVALID_ACTION,
    terminal_state: null,
  };
  const evalIllegal = evaluateTrajectory(tIllegal);
  assert.equal(evalIllegal.eligible, false);
  assert.ok(evalIllegal.reason.toLowerCase().includes("action"));

  // 12. Invalid provenance
  const tProv = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    invalid_provenance: true,
  };
  const evalProv = evaluateTrajectory(tProv);
  assert.equal(evalProv.eligible, false);
  assert.ok(evalProv.reason.toLowerCase().includes("provenance"));
});

test("Task 9: Factual outcome aggregation accurately computes metrics and preserves uncached_input_tokens: null", () => {
  // Trajectory with acceptance on first pass
  const trajFirstPass = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    steps: [
      {
        decision_type: "WORKER_TIER",
        chosen_action: "FLASH_LOW",
        result: "SUCCESS",
      },
    ],
    cost_metrics: {
      model_calls: 1,
      role_turns: 2,
      tool_calls: 3,
      input_tokens: 1500,
      output_tokens: 250,
      cached_input_tokens: 1000,
      uncached_input_tokens: 500, // Should be normalized to null!
      latency_ms: 1200,
    },
    evidence_completeness: {
      required: ["tests", "lint"],
      observed: { tests: "PASS", lint: "PASS" },
      complete: true,
    },
  };

  const evalFirstPass = evaluateTrajectory(trajFirstPass);
  assert.equal(evalFirstPass.eligible, true);
  assert.equal(evalFirstPass.accepted, true);
  assert.equal(evalFirstPass.first_pass_acceptance, true);
  assert.equal(evalFirstPass.retries, 0);
  assert.deepEqual(evalFirstPass.retry_reasons, []);
  assert.equal(evalFirstPass.evidence_completeness.complete, true);
  assert.equal(evalFirstPass.cost_metrics.model_calls, 1);
  assert.equal(evalFirstPass.cost_metrics.role_turns, 2);
  assert.equal(evalFirstPass.cost_metrics.tool_calls, 3);
  assert.equal(evalFirstPass.cost_metrics.input_tokens, 1500);
  assert.equal(evalFirstPass.cost_metrics.output_tokens, 250);
  // CRITICAL RULE 6: uncached_input_tokens MUST be null
  assert.strictEqual(evalFirstPass.cost_metrics.uncached_input_tokens, null);
  assert.equal(evalFirstPass.cost_metrics.latency_ms, 1200);

  // Trajectory with retries
  const trajWithRetries = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    steps: [
      {
        decision_type: "WORKER_TIER",
        chosen_action: "FLASH_LOW",
        result: "TEST_FAILED",
      },
      {
        decision_type: "RETRY_ACTION",
        chosen_action: "DIRECT_DELTA_REPAIR",
        retry_state: { is_retry: true, reason: "TEST_FAILED" },
        result: "LINT_FAILED",
      },
      {
        decision_type: "RETRY_ACTION",
        chosen_action: "DIAGNOSTIC_FIRST_INVESTIGATION",
        retry_state: { is_retry: true, reason: "LINT_FAILED" },
        result: "SUCCESS",
      },
    ],
    cost_metrics: {
      model_calls: 3,
      latency_ms: 4500,
    },
  };

  const evalRetries = evaluateTrajectory(trajWithRetries);
  assert.equal(evalRetries.eligible, true);
  assert.equal(evalRetries.accepted, true);
  assert.equal(evalRetries.first_pass_acceptance, false);
  assert.equal(evalRetries.retries, 2);
  assert.deepEqual(evalRetries.retry_reasons.sort(), ["LINT_FAILED", "TEST_FAILED"]);
});

test("Task 9: Strict lexicographic comparison in immutable priority order (no weighted sums)", () => {
  // 1. Safety/Fidelity: Ineligible trajectory compared against eligible trajectory
  const evalIneligible = {
    eligible: false,
    reason: "Governance violation",
    accepted: true,
  };
  const evalEligible = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: true,
    retries: 0,
    cost_metrics: { model_calls: 10, latency_ms: 5000 },
  };
  const cmp1 = compareTrajectoryFacts(evalIneligible, evalEligible);
  assert.equal(cmp1.relation, COMPARISON_RELATION.INELIGIBLE);

  // 2. Acceptance: Accepted vs Not Accepted
  // Accepted wins even if Not Accepted has better metrics across ALL lower priorities (0 retries, 1 token, 1ms latency)
  const evalAcceptedWorseCost = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: false,
    retries: 3,
    cost_metrics: { model_calls: 10, input_tokens: 10000, output_tokens: 2000, latency_ms: 20000 },
  };
  const evalFailedBestCost = {
    eligible: true,
    accepted: false,
    evidence_completeness: { complete: true },
    first_pass_acceptance: false,
    retries: 0,
    cost_metrics: { model_calls: 1, input_tokens: 10, output_tokens: 5, latency_ms: 10 },
  };
  const cmp2 = compareTrajectoryFacts(evalAcceptedWorseCost, evalFailedBestCost);
  assert.equal(cmp2.relation, COMPARISON_RELATION.SUPERIOR);
  assert.equal(cmp2.dimension, EVALUATION_DIMENSION.ACCEPTANCE);

  // 3. Evidence Completeness: Complete vs Incomplete
  // Complete wins even if Incomplete has first pass acceptance and lower cost
  const evalComplete = {
    eligible: true,
    accepted: true,
    evidence_completeness: { required: ["tests"], observed: { tests: "PASS" }, complete: true },
    first_pass_acceptance: false,
    retries: 1,
    cost_metrics: { model_calls: 5, input_tokens: 5000, latency_ms: 5000 },
  };
  const evalIncomplete = {
    eligible: true,
    accepted: true,
    evidence_completeness: { required: ["tests"], observed: { tests: "MISSING" }, complete: false },
    first_pass_acceptance: true,
    retries: 0,
    cost_metrics: { model_calls: 1, input_tokens: 100, latency_ms: 100 },
  };
  const cmp3 = compareTrajectoryFacts(evalComplete, evalIncomplete);
  assert.equal(cmp3.relation, COMPARISON_RELATION.SUPERIOR);
  assert.equal(cmp3.dimension, EVALUATION_DIMENSION.EVIDENCE_COMPLETENESS);

  // 4. First-pass Acceptance: First-pass (0 retries) vs non-first-pass
  const evalFirstPass = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: true,
    retries: 0,
    cost_metrics: { model_calls: 4, input_tokens: 4000, latency_ms: 4000 },
  };
  const evalNonFirstPass = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: false,
    retries: 1,
    cost_metrics: { model_calls: 2, input_tokens: 2000, latency_ms: 2000 },
  };
  const cmp4 = compareTrajectoryFacts(evalFirstPass, evalNonFirstPass);
  assert.equal(cmp4.relation, COMPARISON_RELATION.SUPERIOR);
  assert.equal(cmp4.dimension, EVALUATION_DIMENSION.FIRST_PASS_ACCEPTANCE);

  // 5. Retry cost: 1 retry vs 2 retries
  const evalFewerRetries = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: false,
    retries: 1,
    cost_metrics: { model_calls: 5, input_tokens: 5000, latency_ms: 5000 },
  };
  const evalMoreRetries = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: false,
    retries: 2,
    cost_metrics: { model_calls: 3, input_tokens: 3000, latency_ms: 3000 },
  };
  const cmp5 = compareTrajectoryFacts(evalFewerRetries, evalMoreRetries);
  assert.equal(cmp5.relation, COMPARISON_RELATION.SUPERIOR);
  assert.equal(cmp5.dimension, EVALUATION_DIMENSION.RETRY_COST);

  // 6. Model calls: 2 calls vs 4 calls
  const evalFewerCalls = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: true,
    retries: 0,
    cost_metrics: { model_calls: 2, input_tokens: 5000, latency_ms: 5000 },
  };
  const evalMoreCalls = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: true,
    retries: 0,
    cost_metrics: { model_calls: 4, input_tokens: 3000, latency_ms: 3000 },
  };
  const cmp6 = compareTrajectoryFacts(evalFewerCalls, evalMoreCalls);
  assert.equal(cmp6.relation, COMPARISON_RELATION.SUPERIOR);
  assert.equal(cmp6.dimension, EVALUATION_DIMENSION.MODEL_CALLS);

  // 7. Tokens: 1000 tokens vs 2000 tokens
  const evalFewerTokens = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: true,
    retries: 0,
    cost_metrics: { model_calls: 2, input_tokens: 800, output_tokens: 200, latency_ms: 5000 },
  };
  const evalMoreTokens = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: true,
    retries: 0,
    cost_metrics: { model_calls: 2, input_tokens: 1500, output_tokens: 500, latency_ms: 2000 },
  };
  const cmp7 = compareTrajectoryFacts(evalFewerTokens, evalMoreTokens);
  assert.equal(cmp7.relation, COMPARISON_RELATION.SUPERIOR);
  assert.equal(cmp7.dimension, EVALUATION_DIMENSION.TOKENS);

  // 8. Latency: 100ms vs 200ms
  const evalLowerLatency = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: true,
    retries: 0,
    cost_metrics: { model_calls: 2, input_tokens: 1000, output_tokens: 100, latency_ms: 100 },
  };
  const evalHigherLatency = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: true,
    retries: 0,
    cost_metrics: { model_calls: 2, input_tokens: 1000, output_tokens: 100, latency_ms: 200 },
  };
  const cmp8 = compareTrajectoryFacts(evalLowerLatency, evalHigherLatency);
  assert.equal(cmp8.relation, COMPARISON_RELATION.SUPERIOR);
  assert.equal(cmp8.dimension, EVALUATION_DIMENSION.LATENCY);

  // Equivalent: all dimensions equal
  const cmpEq = compareTrajectoryFacts(evalLowerLatency, { ...evalLowerLatency });
  assert.equal(cmpEq.relation, COMPARISON_RELATION.EQUIVALENT);
});

test("Task 9: UNKNOWN_BRANCH trajectory represents lack of support, NOT failure", () => {
  const trajUnknown = {
    status: REPLAY_STATUS.UNKNOWN_BRANCH,
    terminal_state: null,
    steps: [
      {
        decision_type: "WORKER_TIER",
        chosen_action: "FLASH_HIGH",
        result: null,
      },
    ],
  };

  const evalUnknown = evaluateTrajectory(trajUnknown);
  assert.equal(evalUnknown.eligible, true);
  assert.equal(evalUnknown.has_unknown_branch, true);
  assert.equal(evalUnknown.terminal_state, "UNKNOWN_BRANCH");
  assert.equal(evalUnknown.accepted, false);

  const evalKnown = {
    eligible: true,
    accepted: true,
    evidence_completeness: { complete: true },
    first_pass_acceptance: true,
    retries: 0,
    cost_metrics: { model_calls: 1, latency_ms: 500 },
  };

  // Comparing unknown branch against any trajectory returns INSUFFICIENT_SUPPORT / NEEDS_EXPLORATION
  const cmp1 = compareTrajectoryFacts(evalUnknown, evalKnown);
  assert.equal(cmp1.relation, COMPARISON_RELATION.INSUFFICIENT_SUPPORT);
  assert.equal(cmp1.reason, "NEEDS_EXPLORATION");

  const cmp2 = compareTrajectoryFacts(evalKnown, evalUnknown);
  assert.equal(cmp2.relation, COMPARISON_RELATION.INSUFFICIENT_SUPPORT);
  assert.equal(cmp2.reason, "NEEDS_EXPLORATION");
});

test("Task 9: createReplayReport produces structured factual report object", () => {
  const mockWorld = {
    root_snapshot_id: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    task_fingerprint: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  };

  const mockReplay = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    trajectories: [
      {
        status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
        terminal_state: "ACCEPTED",
        steps: [
          { decision_type: "WORKER_TIER", chosen_action: "FLASH_LOW" },
        ],
        cost_metrics: {
          model_calls: 1,
          role_turns: 2,
          tool_calls: 3,
          input_tokens: 1000,
          output_tokens: 200,
          latency_ms: 1500,
        },
        evidence_completeness: { complete: true },
      },
      {
        status: REPLAY_STATUS.UNKNOWN_BRANCH,
        terminal_state: null,
        steps: [],
        cost_metrics: {
          model_calls: 1,
          role_turns: 1,
          tool_calls: 0,
          input_tokens: 500,
          output_tokens: 50,
          latency_ms: 600,
        },
      },
      {
        status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
        terminal_state: "ACCEPTED",
        governance_violation: true,
        steps: [],
        cost_metrics: {},
      },
    ],
  };

  const report = createReplayReport({
    world: mockWorld,
    replay: mockReplay,
    candidatePolicyId: "candidate-v2",
  });

  assert.equal(report.candidate_policy_id, "candidate-v2");
  assert.equal(report.world_root_snapshot_id, mockWorld.root_snapshot_id);
  assert.equal(report.total_trajectories, 3);
  assert.equal(report.eligible_trajectories, 2);
  assert.equal(report.ineligible_trajectories, 1);
  assert.equal(report.complete_support_count, 1);
  assert.equal(report.unknown_branch_count, 1);
  assert.equal(report.accepted_count, 1);
  assert.equal(report.acceptance_rate, 1 / 3);
  assert.equal(report.first_pass_count, 1);
  assert.equal(report.first_pass_rate, 1 / 3);
  assert.equal(report.aggregate_cost_metrics.model_calls, 2);
  assert.equal(report.aggregate_cost_metrics.input_tokens, 1500);
  assert.equal(report.aggregate_cost_metrics.output_tokens, 250);
  assert.strictEqual(report.aggregate_cost_metrics.uncached_input_tokens, null);
  assert.equal(report.aggregate_cost_metrics.latency_ms, 2100);
  assert.ok(Array.isArray(report.evaluated_trajectories));
  assert.equal(report.evaluated_trajectories.length, 3);
});

test("Task 9: Static test asserting evaluator.mjs has zero model-call surface or network/child_process imports", () => {
  const evalPath = resolve(__dirname, "evaluator.mjs");
  const source = readFileSync(evalPath, "utf8");

  // Invariant 1: Zero model calls, SDKs, agent profiles, invoke_subagent
  assert.doesNotMatch(source, /@google\/genai/);
  assert.doesNotMatch(source, /@google\/generative-ai/);
  assert.doesNotMatch(source, /openai/);
  assert.doesNotMatch(source, /anthropic/);
  assert.doesNotMatch(source, /invoke_subagent/);
  assert.doesNotMatch(source, /flash-orchestrator/);
  assert.doesNotMatch(source, /flash-worker/);
  assert.doesNotMatch(source, /luna-/);
  assert.doesNotMatch(source, /terra-/);

  // Invariant 2: Pure deterministic local evaluation (no network, no child_process)
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /node:net/);
  assert.doesNotMatch(source, /node:http/);
  assert.doesNotMatch(source, /node:https/);
  assert.doesNotMatch(source, /\bfetch\b/);

  // Allowed imports: only local dream modules
  const importLines = source.match(/import\s+.*?\s+from\s+["'].*?["']/g) || [];
  for (const line of importLines) {
    const match = line.match(/from\s+["'](.*?)["']/);
    assert.ok(match, `Invalid import line: ${line}`);
    const importPath = match[1];
    assert.ok(
      importPath.startsWith("./"),
      `evaluator.mjs may only import local modules within dream, got: ${importPath}`
    );
  }
});

test("Task 9: Edge cases: invalid trajectory inputs and raw trajectory comparison", () => {
  // Non-object trajectory returns ineligible
  assert.equal(evaluateTrajectory(null).eligible, false);
  assert.equal(evaluateTrajectory(undefined).eligible, false);
  assert.equal(evaluateTrajectory([]).eligible, false);

  // Raw trajectories passed directly to compareTrajectoryFacts
  const rawTrajA = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    cost_metrics: { model_calls: 1, latency_ms: 100 },
  };
  const rawTrajB = {
    status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
    terminal_state: "ACCEPTED",
    cost_metrics: { model_calls: 2, latency_ms: 50 },
  };
  // A has 1 model call vs B's 2 model calls -> A is superior (Dimension 6 Model Calls precedes Dimension 8 Latency)
  const cmp = compareTrajectoryFacts(rawTrajA, rawTrajB);
  assert.equal(cmp.relation, COMPARISON_RELATION.SUPERIOR);
  assert.equal(cmp.dimension, EVALUATION_DIMENSION.MODEL_CALLS);

  // createReplayReport with empty replay
  const emptyReport = createReplayReport({ world: {}, replay: { trajectories: [] } });
  assert.equal(emptyReport.total_trajectories, 0);
  assert.equal(emptyReport.acceptance_rate, 0);
  assert.strictEqual(emptyReport.aggregate_cost_metrics.uncached_input_tokens, null);
});

/* =========================================================================
   Milestone D — Declarative Static Policy Tests
   ========================================================================= */

test("Milestone D: policy schema validation and content-addressing", () => {
  const samplePolicyWithoutId = {
    schema: "orchestra.exploration-policy.v1",
    base_policy: "static-policy-v1",
    description: "Test policy",
    rules: [
      {
        id: "rule-1",
        decision_type: "WORKER_TIER",
        priority: 100,
        when: {
          complexity: ["DIFFICULT"]
        },
        choose: "FLASH_HIGH",
        description: "Difficult task rule"
      }
    ]
  };

  const computedId = computePolicyId(samplePolicyWithoutId);
  assert.match(computedId, /^policy-[a-f0-9]{64}$/);

  const validPolicy = {
    policy_id: computedId,
    ...samplePolicyWithoutId
  };

  // Valid policy passes
  const validRes = validatePolicy(validPolicy);
  assert.equal(validRes.valid, true);
  assert.equal(validRes.errors.length, 0);

  // validateDreamRecord also validates POLICY
  const dreamRecRes = validateDreamRecord("POLICY", validPolicy);
  assert.equal(dreamRecRes.valid, true);

  // Mismatched policy_id fails
  const badIdPolicy = { ...validPolicy, policy_id: "policy-0000000000000000000000000000000000000000000000000000000000000000" };
  const badIdRes = validatePolicy(badIdPolicy);
  assert.equal(badIdRes.valid, false);
  assert.ok(badIdRes.errors.some(e => e.includes("policy_id mismatch")));

  // Invalid schema fails
  const badSchemaPolicy = { ...validPolicy, schema: "wrong.schema" };
  const badSchemaRes = validatePolicy(badSchemaPolicy);
  assert.equal(badSchemaRes.valid, false);

  // Exceeding MAX_POLICY_RULES (128) fails
  const tooManyRules = [];
  for (let i = 0; i <= MAX_POLICY_RULES; i++) {
    tooManyRules.push({
      id: `rule-${i}`,
      decision_type: "WORKER_TIER",
      priority: 10,
      when: {},
      choose: "FLASH_MEDIUM"
    });
  }
  const overflowPolicyRaw = {
    schema: "orchestra.exploration-policy.v1",
    rules: tooManyRules
  };
  const overflowPolicy = {
    policy_id: computePolicyId(overflowPolicyRaw),
    ...overflowPolicyRaw
  };
  const overflowRes = validatePolicy(overflowPolicy);
  assert.equal(overflowRes.valid, false);
  assert.ok(overflowRes.errors.some(e => e.includes("exceeds maximum limit of 128")));

  // Duplicate rule IDs fail
  const dupRulesRaw = {
    schema: "orchestra.exploration-policy.v1",
    rules: [
      { id: "dup-id", decision_type: "WORKER_TIER", priority: 10, when: {}, choose: "FLASH_MEDIUM" },
      { id: "dup-id", decision_type: "WORKER_TIER", priority: 20, when: {}, choose: "FLASH_HIGH" }
    ]
  };
  const dupRes = validatePolicy({ policy_id: computePolicyId(dupRulesRaw), ...dupRulesRaw });
  assert.equal(dupRes.valid, false);
  assert.ok(dupRes.errors.some(e => e.includes("duplicate rule id")));

  // Disallowed when condition fails (no regex, no expressions)
  const badWhenRaw = {
    schema: "orchestra.exploration-policy.v1",
    rules: [
      { id: "bad-when", decision_type: "WORKER_TIER", priority: 10, when: { regex: ".*", jsExpression: "() => true" }, choose: "FLASH_MEDIUM" }
    ]
  };
  const badWhenRes = validatePolicy({ policy_id: computePolicyId(badWhenRaw), ...badWhenRaw });
  assert.equal(badWhenRes.valid, false);
  assert.ok(badWhenRes.errors.some(e => e.includes("disallowed condition field")));

  // Numeric range with min > max fails
  const badRangeRaw = {
    schema: "orchestra.exploration-policy.v1",
    rules: [
      { id: "bad-range", decision_type: "RETRY_ACTION", priority: 10, when: { attempt: { min: 5, max: 2 } }, choose: "RETRY_SAME" }
    ]
  };
  const badRangeRes = validatePolicy({ policy_id: computePolicyId(badRangeRaw), ...badRangeRaw });
  assert.equal(badRangeRes.valid, false);
  assert.ok(badRangeRes.errors.some(e => e.includes("min (5) > max (2)")));

  // Disallowed action for decision_type fails validation
  const badActionRaw = {
    schema: "orchestra.exploration-policy.v1",
    rules: [
      { id: "bad-action-rule", decision_type: "INVESTIGATION_STRATEGY", priority: 10, when: {}, choose: "FLASH_HIGH" }
    ]
  };
  const badActionRes = validatePolicy({ policy_id: computePolicyId(badActionRaw), ...badActionRaw });
  assert.equal(badActionRes.valid, false, "Disallowed action name for decision_type must be invalid");
  assert.ok(badActionRes.errors.some(e => e.includes("invalid action") || e.includes("choose")));

  // Disallowed mutation_seq in when condition fails
  const badMutationSeqRaw = {
    schema: "orchestra.exploration-policy.v1",
    rules: [
      { id: "bad-mutation-seq", decision_type: "WORKER_TIER", priority: 10, when: { mutation_seq: 0 }, choose: "FLASH_MEDIUM" }
    ]
  };
  const badMutationRes = validatePolicy({ policy_id: computePolicyId(badMutationSeqRaw), ...badMutationSeqRaw });
  assert.equal(badMutationRes.valid, false, "mutation_seq in when condition must be rejected");
  assert.ok(badMutationRes.errors.some(e => e.includes("disallowed condition field")));
});

test("Milestone D: static-policy-v1 declarative baseline validity and structure", () => {
  const policyPath = resolve(__dirname, "policies/static-policy-v1.json");
  assert.ok(existsSync(policyPath), "static-policy-v1.json must exist on disk");

  const policy = JSON.parse(readFileSync(policyPath, "utf-8"));
  const valRes = validatePolicy(policy);
  assert.equal(valRes.valid, true, `static-policy-v1.json must be valid: ${valRes.errors.join(", ")}`);

  // Verify content-addressed policy_id
  const expectedId = computePolicyId(policy);
  assert.equal(policy.policy_id, expectedId, "static-policy-v1.json policy_id must match content-addressed hash");

  // Verify covered decision types
  const decisionTypes = new Set(policy.rules.map(r => r.decision_type));
  assert.ok(decisionTypes.has("WORKER_TIER"), "Must cover WORKER_TIER");
  assert.ok(decisionTypes.has("INVESTIGATION_STRATEGY"), "Must cover INVESTIGATION_STRATEGY");
  assert.ok(decisionTypes.has("RETRY_ACTION"), "Must cover RETRY_ACTION");
});

test("Milestone D: pure policy engine evaluation semantics", () => {
  const testPolicyRaw = {
    schema: "orchestra.exploration-policy.v1",
    rules: [
      {
        id: "prio-high-difficult",
        decision_type: "WORKER_TIER",
        priority: 100,
        when: { complexity: ["DIFFICULT"] },
        choose: "FLASH_HIGH"
      },
      {
        id: "prio-med-normal",
        decision_type: "WORKER_TIER",
        priority: 80,
        when: { complexity: ["NORMAL"] },
        choose: "FLASH_MEDIUM"
      },
      {
        id: "prio-low-docs",
        decision_type: "WORKER_TIER",
        priority: 70,
        when: { task_domain: ["DOCS"] },
        choose: "FLASH_LOW"
      },
      {
        id: "numeric-range-attempt",
        decision_type: "RETRY_ACTION",
        priority: 90,
        when: { retry_reason: ["FAILED_TEST"], attempt: { min: 1, max: 2 } },
        choose: "RETRY_SAME"
      },
      {
        id: "conflict-rule-a",
        decision_type: "INVESTIGATION_STRATEGY",
        priority: 50,
        when: { task_action: ["IMPLEMENT"] },
        choose: "IMPLEMENT_DIRECT"
      },
      {
        id: "conflict-rule-b",
        decision_type: "INVESTIGATION_STRATEGY",
        priority: 50,
        when: { task_action: ["IMPLEMENT"] },
        choose: "INVESTIGATE_FIRST"
      }
    ]
  };

  const testPolicy = {
    policy_id: computePolicyId(testPolicyRaw),
    ...testPolicyRaw
  };

  // 1. High priority rule match
  const res1 = evaluatePolicy({
    policy: testPolicy,
    decisionType: "WORKER_TIER",
    state: { complexity: "DIFFICULT", task_domain: "DOCS" },
    availableActions: ["FLASH_HIGH"],
    baselineAction: "FLASH_HIGH"
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.action, "FLASH_HIGH");
  assert.equal(res1.priority, 100);
  assert.deepEqual(res1.matched_rule_ids, ["prio-high-difficult"]);

  // 2. Numeric range matching
  const res2 = evaluatePolicy({
    policy: testPolicy,
    decisionType: "RETRY_ACTION",
    state: { retry_reason: "FAILED_TEST", attempt: 2 },
    availableActions: ["RETRY_SAME", "ESCALATE_WORKER"],
    baselineAction: "RETRY_SAME"
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.action, "RETRY_SAME");
  assert.equal(res2.priority, 90);

  // 3. UNKNOWN remains UNKNOWN: missing attempt never matches numeric range
  const res3 = evaluatePolicy({
    policy: testPolicy,
    decisionType: "RETRY_ACTION",
    state: { retry_reason: "FAILED_TEST" }, // attempt missing
    availableActions: ["RETRY_SAME", "ESCALATE_WORKER"],
    baselineAction: "RETRY_SAME"
  });
  assert.equal(res3.ok, false);
  assert.equal(res3.source, "STATIC_ROUTING_FALLBACK");
  assert.equal(res3.diagnostic, POLICY_STATUS.NO_MATCHING_RULE);

  // 4. Equal priority conflict => POLICY_CONFLICT
  const resConflict = evaluatePolicy({
    policy: testPolicy,
    decisionType: "INVESTIGATION_STRATEGY",
    state: { task_action: "IMPLEMENT" },
    availableActions: ["IMPLEMENT_DIRECT", "INVESTIGATE_FIRST"],
    baselineAction: "IMPLEMENT_DIRECT"
  });
  assert.equal(resConflict.ok, false);
  assert.equal(resConflict.action, "IMPLEMENT_DIRECT"); // falls back to baseline
  assert.equal(resConflict.source, "STATIC_ROUTING_FALLBACK");
  assert.ok(resConflict.diagnostic.includes("POLICY_CONFLICT"));

  // 5. Chosen action outside available_actions => POLICY_INVALID_ACTION
  const resInvalid = evaluatePolicy({
    policy: testPolicy,
    decisionType: "WORKER_TIER",
    state: { complexity: "DIFFICULT" },
    availableActions: ["FLASH_MEDIUM"], // FLASH_HIGH not allowed by governance
    baselineAction: "FLASH_MEDIUM"
  });
  assert.equal(resInvalid.ok, false);
  assert.equal(resInvalid.action, "FLASH_MEDIUM");
  assert.ok(resInvalid.diagnostic.includes("POLICY_INVALID_ACTION"));

  // 6. Invalid policy => degrades safely to baselineAction with diagnostics
  const resCorrupt = evaluatePolicy({
    policy: { schema: "corrupted" },
    decisionType: "WORKER_TIER",
    state: {},
    availableActions: ["FLASH_MEDIUM"],
    baselineAction: "FLASH_MEDIUM"
  });
  assert.equal(resCorrupt.ok, false);
  assert.equal(resCorrupt.action, "FLASH_MEDIUM");
  assert.ok(resCorrupt.diagnostic.includes("INVALID_POLICY"));
});

test("Milestone D: Phase B exhaustive parity shadow test (100% coverage, 100% parity)", () => {
  const policyPath = resolve(__dirname, "policies/static-policy-v1.json");
  const staticPolicy = JSON.parse(readFileSync(policyPath, "utf-8"));

  let eligible_cases = 0;
  let baseline_resolved_cases = 0;
  let router_legal_cases = 0;
  let explicit_policy_matches = 0;
  let action_matches = 0;

  // 1. WORKER_TIER real router parity grid
  // Exhaustive matrix covering all eligible states:
  // - TEST (SIMPLE, NORMAL, DIFFICULT, EXPERIMENTAL)
  // - MECHANICAL_FIX
  // - IMPLEMENT (SIMPLE, NORMAL, DIFFICULT, EXPERIMENTAL, INTEGRATION, DOCS, post-investigation)
  const domains = ["CODE", "UI", "DATA", "INFRA", "TESTING", "RESEARCH", "ORCHESTRA", "GENERAL"];
  const criticalities = ["NORMAL", "MAJOR"];

  const workerTierCases = [];

  // TEST (SIMPLE, NORMAL, DIFFICULT, EXPERIMENTAL)
  for (const comp of ["SIMPLE", "NORMAL", "DIFFICULT", "EXPERIMENTAL"]) {
    for (const dom of [...domains, "DOCS"]) {
      for (const crit of criticalities) {
        workerTierCases.push({ taskAction: "TEST", implementationComplexity: comp.toLowerCase(), taskDomain: dom, criticality: crit });
      }
    }
  }

  // MECHANICAL_FIX
  for (const dom of [...domains, "DOCS"]) {
    for (const crit of criticalities) {
      workerTierCases.push({ taskAction: "MECHANICAL_FIX", taskDomain: dom, criticality: crit });
    }
  }

  // IMPLEMENT (SIMPLE, NORMAL, DIFFICULT, EXPERIMENTAL, INTEGRATION, DOCS, post-investigation)
  for (const comp of ["SIMPLE", "NORMAL", "DIFFICULT", "EXPERIMENTAL"]) {
    for (const dom of domains) {
      for (const crit of criticalities) {
        workerTierCases.push({ taskAction: "IMPLEMENT", implementationComplexity: comp.toLowerCase(), taskDomain: dom, criticality: crit });
        workerTierCases.push({ taskAction: "IMPLEMENT", implementationComplexity: comp.toLowerCase(), taskDomain: dom, criticality: crit, postInvestigation: true });
      }
    }
  }
  for (const dom of domains) {
    for (const crit of criticalities) {
      workerTierCases.push({ taskAction: "IMPLEMENT", integration: true, taskDomain: dom, criticality: crit });
    }
  }
  for (const comp of ["SIMPLE", "NORMAL", "DIFFICULT"]) {
    for (const crit of criticalities) {
      workerTierCases.push({ taskAction: "IMPLEMENT", taskDomain: "DOCS", implementationComplexity: comp.toLowerCase(), criticality: crit });
    }
  }

  for (const facts of workerTierCases) {
    const state = deriveDecisionState(facts);
    const availableActions = deriveAvailableActions(DECISION_TYPES.WORKER_TIER, state);
    if (!availableActions || availableActions.length === 0) continue;

    eligible_cases++;
    const baselineAction = deriveValidatedStaticBaseline({
      decisionType: DECISION_TYPES.WORKER_TIER,
      facts,
      state,
    });
    if (baselineAction) {
      baseline_resolved_cases++;
    }
    if (baselineAction && availableActions.includes(baselineAction)) {
      router_legal_cases++;
    }

    const evalResult = evaluatePolicy({
      policy: staticPolicy,
      decisionType: DECISION_TYPES.WORKER_TIER,
      state,
      availableActions,
      baselineAction,
    });

    if (evalResult.ok) {
      explicit_policy_matches++;
    }
    if (evalResult.action === baselineAction) {
      action_matches++;
    }
  }

  // 2. INVESTIGATION_STRATEGY state grid
  const mutSeqs = [0, 1];
  for (const act of ["IMPLEMENT", "INVESTIGATE", "MECHANICAL_FIX"]) {
    for (const crit of ["NORMAL", "MAJOR", "CRITICAL"]) {
      for (const mut of mutSeqs) {
        for (const postInv of [false, true]) {
          for (const comp of ["NORMAL", "DIFFICULT", "MECHANICAL"]) {
            const state = {
              task_action: act,
              criticality: crit,
              mutation_seq: mut,
              post_investigation: postInv,
              complexity: comp,
              state: "INTAKE"
            };

            const availableActions = deriveAvailableActions(DECISION_TYPES.INVESTIGATION_STRATEGY, state);
            if (!availableActions || availableActions.length === 0) {
              continue;
            }

            eligible_cases++;
            const baselineAction = deriveValidatedStaticBaseline({
              decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
              facts: state,
              state,
            });
            if (baselineAction) {
              baseline_resolved_cases++;
            }
            if (baselineAction && availableActions.includes(baselineAction)) {
              router_legal_cases++;
            }

            const evalResult = evaluatePolicy({
              policy: staticPolicy,
              decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
              state,
              availableActions,
              baselineAction
            });

            if (evalResult.ok) {
              explicit_policy_matches++;
            }
            if (evalResult.action === baselineAction) {
              action_matches++;
            }
          }
        }
      }
    }
  }

  // 3. RETRY_ACTION state grid
  const retryReasons = [
    "FAILED_TEST",
    "INCOMPLETE_IMPLEMENTATION",
    "MISSING_CONTEXT",
    "MISINTERPRETED_REQUIREMENT",
    "SCOPE_GAP",
    "INTEGRATION_FAILURE"
  ];

  for (const reason of retryReasons) {
    for (const attempt of [1, 2]) {
      for (const remaining of [0, 1, 2]) {
        const state = {
          task_action: "IMPLEMENT",
          retry_reason: reason,
          attempt,
          retry_remaining: remaining,
          state: "EXECUTING"
        };

        const availableActions = deriveAvailableActions(DECISION_TYPES.RETRY_ACTION, state);
        if (!availableActions || availableActions.length === 0) {
          continue;
        }

        eligible_cases++;
        const baselineAction = deriveValidatedStaticBaseline({
          decisionType: DECISION_TYPES.RETRY_ACTION,
          facts: state,
          state,
        });
        if (baselineAction) {
          baseline_resolved_cases++;
        }
        if (baselineAction && availableActions.includes(baselineAction)) {
          router_legal_cases++;
        }

        const evalResult = evaluatePolicy({
          policy: staticPolicy,
          decisionType: DECISION_TYPES.RETRY_ACTION,
          state,
          availableActions,
          baselineAction
        });

        if (evalResult.ok) {
          explicit_policy_matches++;
        }
        if (evalResult.action === baselineAction) {
          action_matches++;
        }
      }
    }
  }

  const coverage_percent = eligible_cases > 0 ? (explicit_policy_matches / eligible_cases) * 100 : 0;
  const parity_percent = eligible_cases > 0 ? (action_matches / eligible_cases) * 100 : 0;

  console.log(`\n--- REAL ROUTER PARITY SHADOW VERIFICATION REPORT ---`);
  console.log(`eligible_cases: ${eligible_cases}`);
  console.log(`baseline_resolved_cases: ${baseline_resolved_cases}`);
  console.log(`router_legal_cases: ${router_legal_cases}`);
  console.log(`explicit_policy_matches: ${explicit_policy_matches}`);
  console.log(`action_matches: ${action_matches}`);
  console.log(`coverage_percent: ${coverage_percent}%`);
  console.log(`parity_percent: ${parity_percent}%`);
  console.log(`-----------------------------------------------------\n`);

  assert.equal(baseline_resolved_cases, eligible_cases, `baseline_resolved_cases must equal eligible_cases`);
  assert.equal(router_legal_cases, eligible_cases, `router_legal_cases must equal eligible_cases`);
  assert.equal(explicit_policy_matches, eligible_cases, `explicit_policy_matches must equal eligible_cases`);
  assert.equal(action_matches, eligible_cases, `action_matches must equal eligible_cases`);
  assert.equal(coverage_percent, 100, `explicit_policy_coverage must be 100%, got ${coverage_percent}%`);
  assert.equal(parity_percent, 100, `action_parity must be 100%, got ${parity_percent}%`);
});

test("Milestone D: Exact replay with declarative policy engine callback", () => {
  const policyPath = resolve(__dirname, "policies/static-policy-v1.json");
  const staticPolicy = JSON.parse(readFileSync(policyPath, "utf-8"));

  const rootSnapshotId = "sha256:0000000000000000000000000000000000000000000000000000000000000001";
  const runtimeFp = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

  const dec1 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-replay-policy-1",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { complexity: "NORMAL", task_domain: "CODE" },
    available_actions: ["FLASH_MEDIUM", "FLASH_HIGH"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_POLICY_V1",
    actor_identity: "ORCHESTRATOR",
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const out1 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-replay-policy-1",
    observation_id: "obs-replay-policy-1",
    result: "SUCCESS",
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { model_calls: 1 },
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const sealRes = sealWorld({
    events: [dec1, out1],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED", `World must seal cleanly: ${sealRes.errors?.join(", ")}`);
  const world = sealRes.world;

  // Replay callback using pure policy engine
  const chooseAction = (ctx) => {
    const res = evaluatePolicy({
      policy: staticPolicy,
      decisionType: ctx.decisionType,
      state: ctx.state,
      availableActions: ctx.availableActions,
      baselineAction: ctx.availableActions[0]
    });
    return res.action;
  };

  const replayResult = replayExact({ world, chooseAction });
  assert.equal(replayResult.status, REPLAY_STATUS.EXACT_REPLAY_COMPLETE);
  assert.equal(replayResult.trajectories.length, 1);
  assert.equal(replayResult.trajectories[0].terminal_state, "ACCEPTED");
  assert.equal(replayResult.trajectories[0].steps[0].chosen_action, "FLASH_MEDIUM");
});

test("Policy structural contract parity and semantic invariants", () => {
  const schemaPath = resolve(__dirname, "schemas/policy-v1.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

  function validateJsonSchema(s, data) {
    if (!s || typeof s !== "object") return true;

    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const matchesType = types.some(t => {
        if (t === "object") return typeof data === "object" && data !== null && !Array.isArray(data);
        if (t === "array") return Array.isArray(data);
        if (t === "string") return typeof data === "string";
        if (t === "integer") return Number.isInteger(data);
        if (t === "boolean") return typeof data === "boolean";
        if (t === "null") return data === null;
        return false;
      });
      if (!matchesType) return false;
    }

    if (s.const !== undefined && data !== s.const) return false;
    if (s.enum && !s.enum.includes(data)) return false;
    if (s.pattern && typeof data === "string" && !new RegExp(s.pattern).test(data)) return false;
    if (s.minLength !== undefined && typeof data === "string" && data.length < s.minLength) return false;
    if (s.minimum !== undefined && typeof data === "number" && data < s.minimum) return false;

    if (Array.isArray(data)) {
      if (s.minItems !== undefined && data.length < s.minItems) return false;
      if (s.maxItems !== undefined && data.length > s.maxItems) return false;
      if (s.items) {
        for (const item of data) {
          if (!validateJsonSchema(s.items, item)) return false;
        }
      }
    }

    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      if (s.required) {
        for (const req of s.required) {
          if (!(req in data)) return false;
        }
      }
      if (s.properties) {
        for (const [k, v] of Object.entries(data)) {
          if (s.properties[k]) {
            if (!validateJsonSchema(s.properties[k], v)) return false;
          }
        }
      }
      if (s.additionalProperties === false && s.properties) {
        for (const k of Object.keys(data)) {
          if (!s.properties[k]) return false;
        }
      }
    }

    if (s.oneOf) {
      const matches = s.oneOf.filter(sub => validateJsonSchema(sub, data)).length;
      if (matches !== 1) return false;
    }

    if (s.allOf) {
      for (const sub of s.allOf) {
        if (!validateJsonSchema(sub, data)) return false;
      }
    }

    if (s.if) {
      const ifMatches = validateJsonSchema(s.if, data);
      if (ifMatches && s.then) {
        if (!validateJsonSchema(s.then, data)) return false;
      }
    }

    return true;
  }

  function makePolicy(raw) {
    try {
      return { policy_id: computePolicyId(raw), ...raw };
    } catch {
      return raw;
    }
  }

  const baseRaw = {
    schema: "orchestra.exploration-policy.v1",
    base_policy: null,
    description: "Differential test baseline",
    created_at: "2026-09-17T00:00:00Z",
    rules: [
      {
        id: "base-rule-1",
        decision_type: "WORKER_TIER",
        priority: 10,
        when: { task_action: ["IMPLEMENT"] },
        choose: "FLASH_MEDIUM",
        description: "Base rule",
      },
    ],
  };

  const structuralFixtures = [
    {
      name: "valid_minimal",
      policy: makePolicy(baseRaw),
      expectedValid: true,
    },
    {
      name: "valid_comprehensive",
      policy: makePolicy({
        ...baseRaw,
        rules: [
          {
            id: "comp-worker",
            decision_type: "WORKER_TIER",
            priority: 90,
            when: {
              task_action: ["IMPLEMENT"],
              task_domain: ["CODE"],
              criticality: ["NORMAL"],
              complexity: ["DIFFICULT"],
              state: ["EXECUTING"],
              post_investigation: true,
            },
            choose: "FLASH_HIGH",
          },
          {
            id: "comp-retry",
            decision_type: "RETRY_ACTION",
            priority: 80,
            when: {
              retry_reason: ["FAILED_TEST"],
              attempt: { min: 1, max: 3 },
              retry_remaining: [0, 1],
              evidence: {
                tests: ["FAIL"],
                typecheck: ["PASS", "NOT_REQUIRED"],
                build: ["PASS"],
                scope_check: ["PASS"],
                validation_fresh: true,
              },
            },
            choose: "RETRY_SAME",
          },
          {
            id: "comp-investigate",
            decision_type: "INVESTIGATION_STRATEGY",
            priority: 70,
            when: {
              task_action: ["IMPLEMENT"],
              attempt: 0,
            },
            choose: "INVESTIGATE_FIRST",
          },
        ],
      }),
      expectedValid: true,
    },
    {
      name: "invalid_top_level_unknown_property",
      policy: makePolicy({ ...baseRaw, unknown_property: "disallowed" }),
      expectedValid: false,
    },
    {
      name: "invalid_top_level_description_integer",
      policy: makePolicy({ ...baseRaw, description: 42 }),
      expectedValid: false,
    },
    {
      name: "invalid_top_level_base_policy_integer",
      policy: makePolicy({ ...baseRaw, base_policy: 42 }),
      expectedValid: false,
    },
    {
      name: "invalid_top_level_created_at_boolean",
      policy: makePolicy({ ...baseRaw, created_at: false }),
      expectedValid: false,
    },
    {
      name: "invalid_rule_description_object",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], description: {} }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_retry_remaining_negative",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { retry_remaining: -1 } }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_rule_unknown_property",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], unexpected_rule_prop: 123 }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_when_unknown_property",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { task_action: ["IMPLEMENT"], unknown_when_field: true } }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_evidence_unknown_property",
      policy: makePolicy({
        ...baseRaw,
        rules: [
          {
            id: "ev-test",
            decision_type: "RETRY_ACTION",
            priority: 10,
            when: { evidence: { tests: ["PASS"], disallowed_ev_field: 1 } },
            choose: "RETRY_SAME",
          },
        ],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_post_investigation_array",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { post_investigation: [true] } }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_attempt_negative_integer",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { attempt: -1 } }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_attempt_negative_range_min",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { attempt: { min: -1, max: 2 } } }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_attempt_range_extra_property",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { attempt: { min: 1, max: 2, extra: 3 } } }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_attempt_empty_array",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { attempt: [] } }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_task_action_empty_array",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { task_action: [] } }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_task_action_enum_value",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { task_action: ["NON_EXISTENT_ACTION"] } }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_complexity_enum_value",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { complexity: ["SUPER_COMPLEX"] } }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_evidence_tests_enum_value",
      policy: makePolicy({
        ...baseRaw,
        rules: [
          {
            id: "ev-enum-test",
            decision_type: "RETRY_ACTION",
            priority: 10,
            when: { evidence: { tests: ["MAYBE"] } },
            choose: "RETRY_SAME",
          },
        ],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_decision_type",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], decision_type: "UNKNOWN_TYPE" }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_choose_action_for_decision_type",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], choose: "FLASH_ULTRA" }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_empty_rules_array",
      policy: makePolicy({
        ...baseRaw,
        rules: [],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_empty_rule_id",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], id: "" }],
      }),
      expectedValid: false,
    },
    {
      name: "invalid_state_planning_enum",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { state: ["PLANNING"] } }],
      }),
      expectedValid: false,
    },
  ];

  const semanticFixtures = [
    {
      name: "semantic_attempt_min_greater_than_max",
      policy: makePolicy({
        ...baseRaw,
        rules: [{ ...baseRaw.rules[0], when: { attempt: { min: 5, max: 2 } } }],
      }),
    },
    {
      name: "semantic_duplicate_rule_id",
      policy: makePolicy({
        ...baseRaw,
        rules: [
          { ...baseRaw.rules[0], id: "duplicate-rule-id" },
          { ...baseRaw.rules[0], id: "duplicate-rule-id", priority: 20 },
        ],
      }),
    },
    {
      name: "semantic_corrupted_policy_id",
      policy: {
        ...baseRaw,
        policy_id: "policy-0000000000000000000000000000000000000000000000000000000000000000",
      },
    },
  ];

  let passedStructural = 0;
  for (const fixture of structuralFixtures) {
    const schemaValid = validateJsonSchema(schema, fixture.policy);
    const engineRes = validatePolicy(fixture.policy);
    const engineValid = engineRes.valid;

    assert.equal(
      schemaValid,
      fixture.expectedValid,
      `Structural fixture "${fixture.name}" schema validation mismatch: expected ${fixture.expectedValid}, got ${schemaValid}`
    );
    assert.equal(
      engineValid,
      fixture.expectedValid,
      `Structural fixture "${fixture.name}" engine validation mismatch: expected ${fixture.expectedValid}, got ${engineValid} (${engineRes.errors?.join("; ")})`
    );
    assert.equal(
      schemaValid,
      engineValid,
      `Structural fixture "${fixture.name}" contract divergence: schema=${schemaValid}, engine=${engineValid}`
    );
    passedStructural++;
  }
  assert.equal(passedStructural, structuralFixtures.length);

  let passedSemantic = 0;
  for (const fixture of semanticFixtures) {
    const schemaValid = validateJsonSchema(schema, fixture.policy);
    const engineRes = validatePolicy(fixture.policy);
    const engineValid = engineRes.valid;

    assert.equal(
      schemaValid,
      true,
      `Semantic fixture "${fixture.name}" should be valid under JSON Schema draft 2020-12 structural rules, got false`
    );
    assert.equal(
      engineValid,
      false,
      `Semantic fixture "${fixture.name}" must be rejected by validatePolicy semantic invariants, got true`
    );
    passedSemantic++;
  }
  assert.equal(passedSemantic, semanticFixtures.length);
});
