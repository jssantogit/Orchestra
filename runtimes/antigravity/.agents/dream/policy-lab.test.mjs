import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { sha256Canonical } from "./canonical.mjs";
import { createDreamEvent, DREAM_SCHEMAS } from "./records.mjs";
import { sealWorld, writeSealedWorld } from "./world-sealer.mjs";
import {
  POLICY_LAB_LIMITS,
  buildAndPersistPolicyDataset,
  buildPolicyDesignerPacket,
  buildPolicyDevelopmentDataset,
  deriveLineageAssignments,
  evaluatePolicyLabCycle,
  loadCurrentPolicy,
  openPolicyLabCycle,
  splitLineage,
  submitDesignerCandidates,
} from "./policy-lab.mjs";

const RAW_SENTINEL = "RAW_HISTORY_SENTINEL_MUST_NEVER_REACH_DATASET";

function rootForSplit(target, start = 1) {
  for (let i = start; i < start + 10000; i++) {
    const root = sha256Canonical({ milestone_f_root: i });
    if (splitLineage(root).split === target) return root;
  }
  throw new Error("Unable to find deterministic " + target + " root");
}

function makeWorld({ rootSnapshotId, worldId, runtimeFingerprint, sentinel = RAW_SENTINEL }) {
  const state = {
    task_action: "IMPLEMENT",
    task_domain: "CODE",
    criticality: "NORMAL",
    complexity: "NORMAL",
    state: "EXECUTING",
    attempt: 0,
    retry_remaining: 1,
    retry_reason: null,
    post_investigation: false,
    evidence: {
      tests: "PASS",
      typecheck: "NOT_REQUIRED",
      build: "NOT_REQUIRED",
      scope_check: "PASS",
      validation_fresh: true,
    },
  };
  const available = ["FLASH_LOW", "FLASH_MEDIUM", "FLASH_HIGH"];

  const mediumDecision = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: worldId + "-medium",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state,
    available_actions: available,
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_POLICY_V1",
    actor_identity: "ORCHESTRATOR",
    created_at: "2026-09-18T12:00:00.000Z",
    step_idx: 0,
    branch_ordinal: 0,
  });
  const mediumOutcome = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: mediumDecision.decision_id,
    observation_id: worldId + "-medium-obs",
    result: { status: "SUCCESS", private_note: sentinel },
    evidence_summary: {
      tests: "PASS",
      typecheck: "NOT_REQUIRED",
      build: "NOT_REQUIRED",
      scope_check: "PASS",
      validation_fresh: true,
    },
    retry_state: { retry_remaining: 1 },
    cost_metrics: {
      model_calls: 10,
      input_tokens: 1000,
      output_tokens: 200,
      latency_ms: 1000,
    },
    terminal_state: "ACCEPTED",
    resulting_snapshot_id: null,
    created_at: "2026-09-18T12:00:01.000Z",
  });

  const lowDecision = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: worldId + "-low",
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state,
    available_actions: available,
    chosen_action: "FLASH_LOW",
    policy_source: "EXPLORATION_LAB",
    actor_identity: "ORCHESTRATOR",
    created_at: "2026-09-18T12:00:02.000Z",
    step_idx: 0,
    branch_ordinal: 1,
  });
  const lowOutcome = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: lowDecision.decision_id,
    observation_id: worldId + "-low-obs",
    result: { status: "SUCCESS", private_note: sentinel },
    evidence_summary: {
      tests: "PASS",
      typecheck: "NOT_REQUIRED",
      build: "NOT_REQUIRED",
      scope_check: "PASS",
      validation_fresh: true,
    },
    retry_state: { retry_remaining: 1 },
    cost_metrics: {
      model_calls: 4,
      input_tokens: 500,
      output_tokens: 100,
      latency_ms: 500,
    },
    terminal_state: "ACCEPTED",
    resulting_snapshot_id: null,
    created_at: "2026-09-18T12:00:03.000Z",
  });

  const sealed = sealWorld({
    events: [mediumDecision, mediumOutcome, lowDecision, lowOutcome],
    expectedRuntimeFingerprint: runtimeFingerprint,
    rootSnapshotId,
    worldId,
  });
  assert.equal(sealed.status, "SEALED", JSON.stringify(sealed.errors));
  return sealed.world;
}

function candidate(choose, id) {
  return {
    schema: "orchestra.exploration-policy.v1",
    base_policy: null,
    description: "Milestone F test candidate",
    rules: [
      {
        id,
        decision_type: "WORKER_TIER",
        priority: 110,
        when: { complexity: ["NORMAL"] },
        choose,
      },
    ],
  };
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "orchestra-f-policy-lab-"));
  mkdirSync(join(repo, ".agents", "dream-data", "worlds"), { recursive: true });

  const current = loadCurrentPolicy(repo);
  assert.equal(current.ok, true, JSON.stringify(current));

  const runtimeFingerprint = sha256Canonical({ runtime: "milestone-f-test" });
  const trainRoot = rootForSplit("TRAIN", 1);
  const holdoutRoot = rootForSplit("HOLDOUT", 20000);
  assert.notEqual(trainRoot, holdoutRoot);

  const trainWorld = makeWorld({
    rootSnapshotId: trainRoot,
    worldId: "world-f-train",
    runtimeFingerprint,
  });
  const holdoutWorld = makeWorld({
    rootSnapshotId: holdoutRoot,
    worldId: "world-f-holdout",
    runtimeFingerprint,
  });

  assert.equal(writeSealedWorld(repo, trainWorld).written, true);
  assert.equal(writeSealedWorld(repo, holdoutWorld).written, true);

  return {
    repo,
    currentPolicy: current.policy,
    trainWorld,
    holdoutWorld,
  };
}

test("Milestone F constants freeze train/holdout and designer-call budgets", () => {
  assert.equal(POLICY_LAB_LIMITS.train_percent, 80);
  assert.equal(POLICY_LAB_LIMITS.holdout_percent, 20);
  assert.equal(POLICY_LAB_LIMITS.max_structured_examples, 20);
  assert.equal(POLICY_LAB_LIMITS.max_designer_calls, 2);
  assert.equal(POLICY_LAB_LIMITS.max_candidates_per_call, 4);
  assert.equal(Object.isFrozen(POLICY_LAB_LIMITS), true);
});

test("causally descendant worlds inherit the same frozen lineage split", () => {
  const parentRoot = sha256Canonical({ root: "parent" });
  const childRoot = sha256Canonical({ root: "child" });
  const parent = {
    world_manifest_hash: sha256Canonical({ world: "parent" }),
    root_snapshot_id: parentRoot,
    decisions: [{ snapshot_id: parentRoot }, { snapshot_id: childRoot }],
    outcomes: [],
  };
  const child = {
    world_manifest_hash: sha256Canonical({ world: "child" }),
    root_snapshot_id: childRoot,
    decisions: [{ snapshot_id: childRoot }],
    outcomes: [],
  };

  const assignments = deriveLineageAssignments([child, parent]);
  const a = assignments.get(parent.world_manifest_hash);
  const b = assignments.get(child.world_manifest_hash);

  assert.equal(a.lineage_root_snapshot_id, parentRoot);
  assert.equal(b.lineage_root_snapshot_id, parentRoot);
  assert.equal(a.lineage_ref, b.lineage_ref);
  assert.equal(a.split, b.split);
  assert.equal(a.bucket, b.bucket);
});

test("PolicyDevelopmentDataset is deterministic, aggregated, and excludes raw history", () => {
  const f = fixture();
  try {
    const a = buildPolicyDevelopmentDataset({
      worlds: [f.trainWorld, f.holdoutWorld],
      currentPolicy: f.currentPolicy,
    });
    const b = buildPolicyDevelopmentDataset({
      worlds: [f.holdoutWorld, f.trainWorld],
      currentPolicy: f.currentPolicy,
    });

    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(a.dataset.dataset_id, b.dataset.dataset_id);
    assert.deepEqual(a.dataset, b.dataset);
    assert.equal(a.dataset.split_counts.train_lineages, 1);
    assert.equal(a.dataset.split_counts.holdout_lineages, 1);
    assert.equal(a.dataset.source_world_count, 2);
    assert.ok(a.dataset.state_buckets.length >= 1);
    const normalBucket = a.dataset.state_buckets.find((bucket) => bucket.state?.complexity === "NORMAL");
    assert.ok(normalBucket);
    assert.equal(normalBucket.action_support.FLASH_LOW.unknown, false);
    assert.equal(normalBucket.action_support.FLASH_MEDIUM.unknown, false);
    assert.equal(normalBucket.action_support.FLASH_HIGH.unknown, true);
    assert.ok(a.dataset.action_support.unknown_branches >= 2, "FLASH_HIGH must remain UNKNOWN_BRANCH");
    assert.equal(a.dataset.current_policy.policy_id, f.currentPolicy.policy_id);

    const serialized = JSON.stringify(a.dataset);
    assert.equal(serialized.includes(RAW_SENTINEL), false);
    assert.equal(serialized.includes("private_note"), false);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("Policy Lab refuses to open a cycle from a merely content-addressed but unpersisted dataset", () => {
  const f = fixture();
  try {
    const built = buildPolicyDevelopmentDataset({
      worlds: [f.trainWorld, f.holdoutWorld],
      currentPolicy: f.currentPolicy,
    });
    assert.equal(built.ok, true);
    const opened = openPolicyLabCycle({
      repoRoot: f.repo,
      dataset: built.dataset,
    });
    assert.equal(opened.opened, false);
    assert.equal(opened.reason, "DATASET_NOT_BUILT_LOCALLY");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("Policy Lab cycle keeps baseline, evaluates candidates, and never activates them", () => {
  const f = fixture();
  try {
    const built = buildAndPersistPolicyDataset(f.repo);
    assert.equal(built.ok, true, JSON.stringify(built));

    const opened = openPolicyLabCycle({ repoRoot: f.repo, dataset: built.dataset });
    assert.equal(opened.opened, true, JSON.stringify(opened));
    assert.equal(opened.cycle.candidates.length, 1);
    assert.equal(opened.cycle.candidates[0].source, "BASELINE");
    assert.equal(opened.cycle.activation_allowed, false);
    assert.match(opened.cycle.state_hash, /^sha256:/);

    const packet1 = buildPolicyDesignerPacket({
      repoRoot: f.repo,
      cyclePath: opened.path,
    });
    assert.equal(packet1.ok, true, JSON.stringify(packet1));
    assert.equal(packet1.packet.designer_call_index, 1);
    assert.match(packet1.packet.packet_id, /^packet-[a-f0-9]{64}$/);
    assert.equal(packet1.packet.dataset.source_manifest, undefined);
    assert.equal(JSON.stringify(packet1.packet).includes(RAW_SENTINEL), false);
    assert.equal(packet1.cycle.status, "DESIGNER_PENDING");
    assert.equal(packet1.cycle.designer_calls.length, 1);
    assert.equal(packet1.cycle.designer_calls[0].status, "PACKET_ISSUED");

    const repeatedPacket1 = buildPolicyDesignerPacket({
      repoRoot: f.repo,
      cyclePath: opened.path,
    });
    assert.equal(repeatedPacket1.ok, true);
    assert.equal(repeatedPacket1.pending, true);
    assert.equal(repeatedPacket1.packet.packet_id, packet1.packet.packet_id);
    assert.equal(repeatedPacket1.cycle.designer_calls.length, 1);

    const prematureEvaluation = evaluatePolicyLabCycle({
      repoRoot: f.repo,
      cyclePath: opened.path,
    });
    assert.equal(prematureEvaluation.evaluated, false);
    assert.equal(prematureEvaluation.reason, "DESIGNER_CALL_PENDING");

    const submitted = submitDesignerCandidates({
      repoRoot: f.repo,
      cyclePath: opened.path,
      packetId: packet1.packet.packet_id,
      candidates: [
        candidate("FLASH_LOW", "prefer-low-normal"),
        candidate("FLASH_HIGH", "prefer-high-normal"),
      ],
    });
    assert.equal(submitted.accepted, true, JSON.stringify(submitted));
    assert.equal(submitted.call_index, 1);
    assert.equal(submitted.accepted_candidates.length, 2);

    const lowId = submitted.accepted_candidates[0].policy_id;
    const highId = submitted.accepted_candidates[1].policy_id;

    const evaluation = evaluatePolicyLabCycle({
      repoRoot: f.repo,
      cyclePath: opened.path,
    });
    assert.equal(evaluation.evaluated, true, JSON.stringify(evaluation));
    assert.equal(evaluation.evaluation.activation_allowed, false);
    assert.equal(evaluation.evaluation.next_milestone_required_for_activation, "SHADOW_MODE");
    assert.equal(evaluation.evaluation.sample_gate.sufficient, false);

    const baseline = evaluation.evaluation.candidates.find((x) => x.source === "BASELINE");
    const low = evaluation.evaluation.candidates.find((x) => x.policy_id === lowId);
    const high = evaluation.evaluation.candidates.find((x) => x.policy_id === highId);

    assert.equal(baseline.status, "BASELINE");
    assert.equal(low.status, "RECOMMENDATION_CANDIDATE");
    assert.equal(low.holdout_comparison.relation, "SUPERIOR");
    assert.equal(low.holdout_comparison.dimension, "MODEL_CALLS");
    assert.equal(low.materiality.material, true);
    assert.ok(low.materiality.reasons.includes("MODEL_CALLS_REDUCTION_GTE_5_PERCENT"));

    assert.equal(high.status, "NEEDS_EXPLORATION");
    assert.ok(high.holdout.unknown_branch_count > 0);
    assert.deepEqual(evaluation.evaluation.recommended_candidate_ids, [lowId]);

    assert.equal(
      existsSync(join(f.repo, ".agents", "dream-data", "policies", "active.json")),
      false,
      "Milestone F must have no activation path",
    );

    const packet2 = buildPolicyDesignerPacket({
      repoRoot: f.repo,
      cyclePath: opened.path,
    });
    assert.equal(packet2.ok, true, JSON.stringify(packet2));
    assert.equal(packet2.packet.designer_call_index, 2);
    assert.match(packet2.packet.packet_id, /^packet-[a-f0-9]{64}$/);
    assert.notEqual(packet2.packet.packet_id, packet1.packet.packet_id);
    assert.ok(packet2.packet.replay_feedback);
    assert.equal(JSON.stringify(packet2.packet).includes(RAW_SENTINEL), false);

    const second = submitDesignerCandidates({
      repoRoot: f.repo,
      cyclePath: opened.path,
      packetId: packet2.packet.packet_id,
      candidates: [],
    });
    assert.equal(second.accepted, true);
    assert.equal(second.call_index, 2);

    const exhaustedPacket = buildPolicyDesignerPacket({
      repoRoot: f.repo,
      cyclePath: opened.path,
    });
    assert.equal(exhaustedPacket.ok, false);
    assert.equal(exhaustedPacket.reason, "DESIGNER_CALL_BUDGET_EXHAUSTED");

    const third = submitDesignerCandidates({
      repoRoot: f.repo,
      cyclePath: opened.path,
      candidates: [],
    });
    assert.equal(third.accepted, false);
    assert.equal(third.reason, "DESIGNER_CALL_BUDGET_EXHAUSTED");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("Policy Lab fails closed on cycle tampering and oversized designer output consumes the call", () => {
  const f = fixture();
  try {
    const built = buildAndPersistPolicyDataset(f.repo);
    const opened = openPolicyLabCycle({ repoRoot: f.repo, dataset: built.dataset });

    const packet = buildPolicyDesignerPacket({
      repoRoot: f.repo,
      cyclePath: opened.path,
    });
    assert.equal(packet.ok, true);

    const oversized = submitDesignerCandidates({
      repoRoot: f.repo,
      cyclePath: opened.path,
      packetId: packet.packet.packet_id,
      candidates: [
        candidate("FLASH_LOW", "c1"),
        candidate("FLASH_LOW", "c2"),
        candidate("FLASH_LOW", "c3"),
        candidate("FLASH_LOW", "c4"),
        candidate("FLASH_LOW", "c5"),
      ],
    });
    assert.equal(oversized.accepted, false);
    assert.equal(oversized.reason, "TOO_MANY_CANDIDATES_IN_CALL");
    assert.equal(oversized.cycle.designer_calls.length, 1);

    const raw = JSON.parse(readFileSync(opened.path, "utf8"));
    raw.designer_calls = [];
    writeFileSync(opened.path, JSON.stringify(raw, null, 2), "utf8");

    const tampered = buildPolicyDesignerPacket({
      repoRoot: f.repo,
      cyclePath: opened.path,
    });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.reason, "CYCLE_STATE_HASH_MISMATCH");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});
