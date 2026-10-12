import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { sha256Canonical } from "./canonical.mjs";
import { recordDecision } from "./decision-recorder.mjs";
import {
  buildAndPersistPolicyDataset,
  buildPolicyDesignerPacket,
  evaluatePolicyLabCycle,
  loadCurrentPolicy,
  openPolicyLabCycle,
  splitLineage,
  submitDesignerCandidates,
} from "./policy-lab.mjs";
import { createDreamEvent, DREAM_SCHEMAS } from "./records.mjs";
import {
  SHADOW_GATES,
  buildShadowSupportIndex,
  disableShadowMode,
  enableShadowMode,
  loadShadowConfig,
  recordShadowObservation,
  summarizeShadowSession,
} from "./shadow-mode.mjs";
import { sealWorld, writeSealedWorld } from "./world-sealer.mjs";

function rootForSplit(target, start = 1) {
  for (let i = start; i < start + 20000; i++) {
    const root = sha256Canonical({ milestone_g_root: i });
    if (splitLineage(root).split === target) return root;
  }
  throw new Error("Unable to find " + target + " root");
}

function policyState({ criticality = "NORMAL", state = "EXECUTING" } = {}) {
  return {
    task_action: "IMPLEMENT",
    task_domain: "CODE",
    criticality,
    complexity: "NORMAL",
    state,
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
}

const ACTIONS = ["FLASH_LOW", "FLASH_MEDIUM", "FLASH_HIGH"];

function factualDecision({
  id,
  snapshotId,
  chosenAction = "FLASH_MEDIUM",
  criticality = "NORMAL",
  state = "EXECUTING",
  source = "STATIC_POLICY_V1",
} = {}) {
  return createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: id,
    snapshot_id: snapshotId,
    decision_type: "WORKER_TIER",
    state: policyState({ criticality, state }),
    available_actions: ACTIONS,
    chosen_action: chosenAction,
    policy_source: source,
    actor_identity: "ORCHESTRATOR",
    created_at: "2026-09-18T14:00:00.000Z",
    step_idx: 0,
    branch_ordinal: 0,
  });
}

function factualOutcome({ decision, calls, observationId } = {}) {
  return createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: decision.decision_id,
    observation_id: observationId,
    result: { status: "SUCCESS", private_note: "must-not-enter-shadow" },
    evidence_summary: {
      tests: "NOT_REQUIRED",
      typecheck: "NOT_REQUIRED",
      build: "NOT_REQUIRED",
      scope_check: "PASS",
      validation_fresh: false,
    },
    retry_state: { retry_remaining: 1 },
    cost_metrics: {
      model_calls: calls,
      input_tokens: calls * 100,
      output_tokens: calls * 20,
      latency_ms: calls * 100,
    },
    terminal_state: "ACCEPTED",
    resulting_snapshot_id: null,
    created_at: "2026-09-18T14:00:01.000Z",
  });
}

function makeWorld({ rootSnapshotId, worldId, runtimeFingerprint } = {}) {
  const medium = factualDecision({
    id: worldId + "-medium",
    snapshotId: rootSnapshotId,
    chosenAction: "FLASH_MEDIUM",
  });
  const low = factualDecision({
    id: worldId + "-low",
    snapshotId: rootSnapshotId,
    chosenAction: "FLASH_LOW",
    source: "EXPLORATION_LAB",
  });
  const sealed = sealWorld({
    events: [
      medium,
      factualOutcome({ decision: medium, calls: 10, observationId: worldId + "-medium-obs" }),
      low,
      factualOutcome({ decision: low, calls: 4, observationId: worldId + "-low-obs" }),
    ],
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
    description: "Milestone G test candidate",
    rules: [{
      id,
      decision_type: "WORKER_TIER",
      priority: 110,
      when: { complexity: ["NORMAL"] },
      choose,
    }],
  };
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "orchestra-g-shadow-"));
  mkdirSync(join(repo, ".agents", "dream-data", "worlds"), { recursive: true });

  const current = loadCurrentPolicy(repo);
  assert.equal(current.ok, true, JSON.stringify(current));

  const runtimeFingerprint = sha256Canonical({ runtime: "milestone-g-test" });
  const trainRoot = rootForSplit("TRAIN", 1);
  const holdoutRoot = rootForSplit("HOLDOUT", 30000);
  const trainWorld = makeWorld({
    rootSnapshotId: trainRoot,
    worldId: "world-g-train",
    runtimeFingerprint,
  });
  const holdoutWorld = makeWorld({
    rootSnapshotId: holdoutRoot,
    worldId: "world-g-holdout",
    runtimeFingerprint,
  });
  assert.equal(writeSealedWorld(repo, trainWorld).written, true);
  assert.equal(writeSealedWorld(repo, holdoutWorld).written, true);

  const dataset = buildAndPersistPolicyDataset(repo);
  assert.equal(dataset.ok, true, JSON.stringify(dataset));
  const cycle = openPolicyLabCycle({ repoRoot: repo, dataset: dataset.dataset });
  assert.equal(cycle.opened, true, JSON.stringify(cycle));
  const packet = buildPolicyDesignerPacket({ repoRoot: repo, cyclePath: cycle.path });
  assert.equal(packet.ok, true, JSON.stringify(packet));
  const submitted = submitDesignerCandidates({
    repoRoot: repo,
    cyclePath: cycle.path,
    packetId: packet.packet.packet_id,
    candidates: [
      candidate("FLASH_LOW", "shadow-low"),
      candidate("FLASH_HIGH", "shadow-high"),
    ],
  });
  assert.equal(submitted.accepted, true, JSON.stringify(submitted));
  const lowId = submitted.accepted_candidates[0].policy_id;
  const highId = submitted.accepted_candidates[1].policy_id;
  const evaluation = evaluatePolicyLabCycle({ repoRoot: repo, cyclePath: cycle.path });
  assert.equal(evaluation.evaluated, true, JSON.stringify(evaluation));

  const low = evaluation.evaluation.candidates.find((x) => x.policy_id === lowId);
  const high = evaluation.evaluation.candidates.find((x) => x.policy_id === highId);
  assert.equal(low.status, "RECOMMENDATION_CANDIDATE");
  assert.equal(high.status, "NEEDS_EXPLORATION");

  return {
    repo,
    trainRoot,
    holdoutRoot,
    lowId,
    highId,
    evaluationId: evaluation.evaluation.evaluation_id,
  };
}

test("Milestone G gates freeze 50 eligible decisions and 20 percent unknown divergence ceiling", () => {
  assert.deepEqual(SHADOW_GATES, {
    min_eligible_decisions: 50,
    max_unknown_divergence_fraction: 0.20,
  });
  assert.equal(Object.isFrozen(SHADOW_GATES), true);
});

test("Shadow support index is content-addressed and contains exact LOW support but no HIGH observation", () => {
  const f = fixture();
  try {
    const a = buildShadowSupportIndex(f.repo);
    const b = buildShadowSupportIndex(f.repo);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.index.support_index_id, b.index.support_index_id);
    const entries = Object.values(a.index.entries);
    assert.ok(entries.length >= 2);
    const train = entries.find((entry) => entry.snapshot_id === f.trainRoot);
    assert.ok(train);
    assert.equal(train.actions.FLASH_LOW.observations, 1);
    assert.equal(train.actions.FLASH_MEDIUM.observations, 1);
    assert.equal(train.actions.FLASH_HIGH, undefined);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("recordDecision keeps baseline execution private from a divergent shadow candidate", () => {
  const f = fixture();
  try {
    const enabled = enableShadowMode({
      repoRoot: f.repo,
      candidatePolicyId: f.lowId,
      evaluationId: f.evaluationId,
    });
    assert.equal(enabled.enabled, true, JSON.stringify(enabled));

    const decision = {
      decision_id: "dec-shadow-integration",
      snapshot_id: f.trainRoot,
      decision_type: "WORKER_TIER",
      state: policyState(),
      available_actions: ACTIONS,
      chosen_action: "FLASH_MEDIUM",
      policy_source: "STATIC_POLICY_V1",
      actor_identity: "ORCHESTRATOR",
      conversation_id: "shadow-integration",
      step_idx: 1,
      tool_call_id: "tool-shadow",
      branch_ordinal: 0,
    };
    const result = recordDecision({
      repoRoot: f.repo,
      snapshot: f.trainRoot,
      decision,
    });
    assert.equal(result.recorded, true, JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes("FLASH_LOW"), false);

    const telemetry = readFileSync(join(f.repo, ".agents", "telemetry", "events.jsonl"), "utf8");
    const published = JSON.parse(telemetry.trim().split("\n").at(-1));
    assert.equal(published.chosen_action, "FLASH_MEDIUM");

    const obsDir = join(
      f.repo,
      ".agents",
      "dream-data",
      "shadow",
      "observations",
      enabled.config.shadow_session_id,
    );
    const files = readdirSync(obsDir).filter((x) => x.endsWith(".json")).sort();
    assert.equal(files.length, 1);
    const observation = JSON.parse(readFileSync(join(obsDir, files[0]), "utf8"));
    assert.equal(observation.baseline_action, "FLASH_MEDIUM");
    assert.equal(observation.candidate_action, "FLASH_LOW");
    assert.equal(observation.divergence, true);
    assert.equal(observation.replay_support.status, "EXACT_SUPPORTED");
    assert.equal(Object.prototype.hasOwnProperty.call(published, "candidate_action"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(published, "divergence"), false);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("Shadow reaches canary-review readiness only after 50 eligible exact-supported decisions", () => {
  const f = fixture();
  try {
    const enabled = enableShadowMode({
      repoRoot: f.repo,
      candidatePolicyId: f.lowId,
      evaluationId: f.evaluationId,
    });
    assert.equal(enabled.enabled, true);

    for (let i = 0; i < 50; i++) {
      const observed = recordShadowObservation({
        repoRoot: f.repo,
        decisionEvent: factualDecision({
          id: "dec-shadow-ready-" + i,
          snapshotId: f.trainRoot,
          chosenAction: "FLASH_MEDIUM",
        }),
      });
      assert.equal(observed.observed, true, JSON.stringify(observed));
      assert.equal(observed.observation.candidate_action, "FLASH_LOW");
      assert.equal(observed.observation.replay_support.status, "EXACT_SUPPORTED");
    }

    const critical = recordShadowObservation({
      repoRoot: f.repo,
      decisionEvent: factualDecision({
        id: "dec-shadow-critical",
        snapshotId: f.trainRoot,
        chosenAction: "FLASH_MEDIUM",
        criticality: "CRITICAL",
      }),
    });
    assert.equal(critical.observed, true);
    assert.equal(critical.observation.eligible, false);
    assert.equal(critical.observation.exclusion_reason, "CRITICAL_EXCLUDED");
    assert.equal(critical.observation.candidate_action, null);

    const report = summarizeShadowSession({ repoRoot: f.repo });
    assert.equal(report.summarized, true, JSON.stringify(report));
    assert.equal(report.report.eligible_decisions, 50);
    assert.equal(report.report.critical_exclusions, 1);
    assert.equal(report.report.divergence_count, 50);
    assert.equal(report.report.unknown_divergence_count, 0);
    assert.equal(report.report.status, "READY_FOR_HUMAN_CANARY_REVIEW");
    assert.equal(report.report.activation_allowed, false);
    assert.equal(report.report.canary_execution_allowed, false);
    assert.equal(report.report.human_approval_required, true);

    const obsDir = join(
      f.repo,
      ".agents",
      "dream-data",
      "shadow",
      "observations",
      enabled.config.shadow_session_id,
    );
    assert.equal(readdirSync(obsDir).filter((x) => x.endsWith(".json")).length, 51);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("Shadow requires support gathering when more than 20 percent of divergences are UNKNOWN_BRANCH", () => {
  const f = fixture();
  try {
    const enabled = enableShadowMode({
      repoRoot: f.repo,
      candidatePolicyId: f.highId,
      evaluationId: f.evaluationId,
    });
    assert.equal(enabled.enabled, true, JSON.stringify(enabled));

    for (let i = 0; i < 50; i++) {
      const observed = recordShadowObservation({
        repoRoot: f.repo,
        decisionEvent: factualDecision({
          id: "dec-shadow-unknown-" + i,
          snapshotId: f.trainRoot,
          chosenAction: "FLASH_MEDIUM",
        }),
      });
      assert.equal(observed.observed, true);
      assert.equal(observed.observation.candidate_action, "FLASH_HIGH");
      assert.equal(observed.observation.replay_support.status, "UNKNOWN_BRANCH");
    }

    const report = summarizeShadowSession({ repoRoot: f.repo });
    assert.equal(report.summarized, true);
    assert.equal(report.report.eligible_decisions, 50);
    assert.equal(report.report.unknown_divergence_count, 50);
    assert.equal(report.report.unknown_divergence_fraction, 1);
    assert.equal(report.report.status, "GATHER_SUPPORT");
    assert.equal(report.report.gates.unknown_support_gate_met, false);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("Shadow config is tamper-evident and disable removes online shadow observation", () => {
  const f = fixture();
  try {
    const enabled = enableShadowMode({
      repoRoot: f.repo,
      candidatePolicyId: f.lowId,
      evaluationId: f.evaluationId,
    });
    assert.equal(enabled.enabled, true);

    const configPath = join(f.repo, ".agents", "dream-data", "shadow", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.candidate_policy_id = f.highId;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

    const tampered = loadShadowConfig(f.repo);
    assert.equal(tampered.active, false);
    assert.equal(tampered.reason, "SHADOW_CONFIG_INVALID");

    const restored = enableShadowMode({
      repoRoot: f.repo,
      candidatePolicyId: f.lowId,
      evaluationId: f.evaluationId,
    });
    assert.equal(restored.enabled, true);
    const disabled = disableShadowMode(f.repo);
    assert.equal(disabled.disabled, true);

    const after = recordShadowObservation({
      repoRoot: f.repo,
      decisionEvent: factualDecision({
        id: "dec-shadow-disabled",
        snapshotId: f.trainRoot,
      }),
    });
    assert.equal(after.observed, false);
    assert.equal(after.reason, "SHADOW_DISABLED");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});
