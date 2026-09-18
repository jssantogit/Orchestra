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
import { CANARY_ROLLOUT_STAGES } from "./canary-rollout.mjs";
import {
  CANARY_GATES,
  advanceCanaryStage,
  approveCanary,
  classifyCanaryEligibility,
  deterministicCanarySelection,
  evaluateCanaryPolicyOverlay,
  isCanaryExternalSideEffect,
  loadCanaryConfig,
  promoteCanary,
  summarizeCanarySession,
} from "./canary-mode.mjs";
import { recordDecision } from "./decision-recorder.mjs";
import { recordDecisionOutcome } from "./outcome-recorder.mjs";
import {
  buildAndPersistPolicyDataset,
  buildPolicyDesignerPacket,
  evaluatePolicyLabCycle,
  loadCurrentPolicy,
  openPolicyLabCycle,
  splitLineage,
  submitDesignerCandidates,
} from "./policy-lab.mjs";
import { loadRuntimePolicy, rollbackActivePolicy } from "./policy-store.mjs";
import { createDreamEvent, DREAM_SCHEMAS } from "./records.mjs";
import {
  enableShadowMode,
  recordShadowObservation,
  summarizeShadowSession,
} from "./shadow-mode.mjs";
import { sealWorld, writeSealedWorld } from "./world-sealer.mjs";

const ACTIONS = ["FLASH_LOW", "FLASH_MEDIUM", "FLASH_HIGH"];

function rootForSplit(target, start = 1) {
  for (let i = start; i < start + 40000; i++) {
    const root = sha256Canonical({ milestone_h_root: i });
    if (splitLineage(root).split === target) return root;
  }
  throw new Error("Unable to find " + target + " root");
}

function policyState({
  criticality = "NORMAL",
  state = "EXECUTING",
  taskAction = "IMPLEMENT",
  taskDomain = "CODE",
} = {}) {
  return {
    task_action: taskAction,
    task_domain: taskDomain,
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

function factualDecision({
  id,
  snapshotId,
  chosenAction = "FLASH_MEDIUM",
  criticality = "NORMAL",
  state = "EXECUTING",
  source = "STATIC_POLICY_V1",
  policyId = null,
  baselineAction = null,
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
    policy_id: policyId,
    baseline_action: baselineAction,
    actor_identity: "ORCHESTRATOR",
    created_at: "2026-09-18T15:00:00.000Z",
    step_idx: 0,
    branch_ordinal: 0,
  });
}

function factualOutcome({ decision, calls, terminal = "ACCEPTED", observationId } = {}) {
  return createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: decision.decision_id,
    observation_id: observationId,
    result: { status: terminal === "ACCEPTED" ? "SUCCESS" : "FAILED" },
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
    terminal_state: terminal,
    resulting_snapshot_id: null,
    created_at: "2026-09-18T15:00:01.000Z",
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
    description: "Milestone H test candidate",
    rules: [{
      id,
      decision_type: "WORKER_TIER",
      priority: 110,
      when: { complexity: ["NORMAL"] },
      choose,
    }],
  };
}

function taskForSelection(
  policyId,
  selected,
  start = 0,
  trafficPercent = CANARY_GATES.initial_traffic_percent,
) {
  for (let i = start; i < start + 100000; i++) {
    const taskId = "task-canary-" + i;
    const result = deterministicCanarySelection(taskId, policyId, trafficPercent);
    if (result.selected === selected) {
      return { taskId, bucket: result.bucket, trafficPercent: result.traffic_percent };
    }
  }
  throw new Error("Unable to resolve deterministic Canary task selection");
}

function safeRuntime(taskId) {
  return {
    taskId,
    activeState: {
      taskId,
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
      state: "EXECUTING",
      complexity: "NORMAL",
      taskSpec: "Edit a local utility implementation and run local tests",
    },
    activeContract: {
      allowedPaths: ["src/**", "test/**"],
      forbiddenPaths: [".agents/**"],
      criticality: "NORMAL",
    },
  };
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "orchestra-h-canary-"));
  mkdirSync(join(repo, ".agents", "dream-data", "worlds"), { recursive: true });

  const current = loadCurrentPolicy(repo);
  assert.equal(current.ok, true, JSON.stringify(current));

  const runtimeFingerprint = sha256Canonical({ runtime: "milestone-h-test" });
  const trainRoot = rootForSplit("TRAIN", 1);
  const holdoutRoot = rootForSplit("HOLDOUT", 50000);
  const trainWorld = makeWorld({
    rootSnapshotId: trainRoot,
    worldId: "world-h-train",
    runtimeFingerprint,
  });
  const holdoutWorld = makeWorld({
    rootSnapshotId: holdoutRoot,
    worldId: "world-h-holdout",
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
    candidates: [candidate("FLASH_LOW", "canary-low")],
  });
  assert.equal(submitted.accepted, true, JSON.stringify(submitted));
  const candidateId = submitted.accepted_candidates[0].policy_id;

  const evaluation = evaluatePolicyLabCycle({ repoRoot: repo, cyclePath: cycle.path });
  assert.equal(evaluation.evaluated, true, JSON.stringify(evaluation));
  const evaluated = evaluation.evaluation.candidates.find((x) => x.policy_id === candidateId);
  assert.equal(evaluated.status, "RECOMMENDATION_CANDIDATE");

  const shadow = enableShadowMode({
    repoRoot: repo,
    candidatePolicyId: candidateId,
    evaluationId: evaluation.evaluation.evaluation_id,
  });
  assert.equal(shadow.enabled, true, JSON.stringify(shadow));

  for (let i = 0; i < 50; i++) {
    const observed = recordShadowObservation({
      repoRoot: repo,
      decisionEvent: factualDecision({
        id: "dec-h-shadow-" + i,
        snapshotId: trainRoot,
        chosenAction: "FLASH_MEDIUM",
      }),
    });
    assert.equal(observed.observed, true, JSON.stringify(observed));
    assert.equal(observed.observation.replay_support.status, "EXACT_SUPPORTED");
  }

  const shadowReport = summarizeShadowSession({ repoRoot: repo });
  assert.equal(shadowReport.summarized, true, JSON.stringify(shadowReport));
  assert.equal(shadowReport.report.status, "READY_FOR_HUMAN_CANARY_REVIEW");

  return {
    repo,
    trainRoot,
    holdoutRoot,
    baselinePolicyId: current.policy.policy_id,
    candidateId,
    shadowReportId: shadowReport.report.report_id,
  };
}

function approveFixture(f) {
  const approval = approveCanary({
    repoRoot: f.repo,
    shadowReportId: f.shadowReportId,
    humanApproval: true,
  });
  assert.equal(approval.approved, true, JSON.stringify(approval));
  return approval;
}


function recordAcceptedCanaryOutcomes(
  f,
  {
    count,
    trafficPercent,
    start,
    label,
  },
) {
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    let selected = taskForSelection(
      f.candidateId,
      true,
      start + (i * 1000),
      trafficPercent,
    );
    while (seen.has(selected.taskId)) {
      selected = taskForSelection(
        f.candidateId,
        true,
        start + (i * 1000) + seen.size + 1,
        trafficPercent,
      );
    }
    seen.add(selected.taskId);

    const runtime = safeRuntime(selected.taskId);
    const overlay = evaluateCanaryPolicyOverlay({
      repoRoot: f.repo,
      taskId: selected.taskId,
      decisionType: "WORKER_TIER",
      state: policyState(),
      availableActions: ACTIONS,
      baselineAction: "FLASH_MEDIUM",
      baselinePolicyId: f.baselinePolicyId,
      activeState: runtime.activeState,
      activeContract: runtime.activeContract,
    });
    assert.equal(overlay.active, true, JSON.stringify(overlay));
    assert.equal(overlay.canary_traffic_percent, trafficPercent);

    const correlationKey = "canary-rollout-" + label + "-" + i;
    const decisionId = "dec-canary-rollout-" + label + "-" + i;
    const recorded = recordDecision({
      repoRoot: f.repo,
      snapshot: f.trainRoot,
      correlationKey,
      decision: {
        decision_id: decisionId,
        snapshot_id: f.trainRoot,
        decision_type: "WORKER_TIER",
        state: policyState(),
        available_actions: ACTIONS,
        chosen_action: overlay.action,
        policy_source: overlay.source,
        policy_id: overlay.policy_id,
        baseline_action: overlay.baseline_action,
        policy_diagnostic: null,
        actor_identity: "ORCHESTRATOR",
        conversation_id: "canary-rollout-" + label,
        step_idx: i + 1,
        tool_call_id: "tool-canary-rollout-" + label + "-" + i,
        branch_ordinal: 0,
      },
    });
    assert.equal(recorded.recorded, true, JSON.stringify(recorded));

    const outcome = recordDecisionOutcome({
      repoRoot: f.repo,
      correlationKey,
      outcome: {
        result: { status: "SUCCESS" },
        evidence_summary: {
          tests: "NOT_REQUIRED",
          typecheck: "NOT_REQUIRED",
          build: "NOT_REQUIRED",
          scope_check: "PASS",
          validation_fresh: false,
        },
        retry_state: { retry_remaining: 1 },
        cost_metrics: {
          model_calls: 1,
          input_tokens: 10,
          output_tokens: 5,
          latency_ms: 5,
        },
        terminal_state: "ACCEPTED",
        resulting_snapshot_id: null,
      },
    });
    assert.equal(outcome.recorded, true, JSON.stringify(outcome));
  }
}

test("Canary rollout uses deterministic nested 5/20/50/100 cohorts and NORMAL only", () => {
  assert.deepEqual(CANARY_GATES, {
    initial_traffic_percent: 5,
    allowed_criticality: "NORMAL",
    rollout_traffic_percents: [5, 20, 50, 100],
  });
  assert.equal(Object.isFrozen(CANARY_GATES), true);
  assert.deepEqual(
    CANARY_ROLLOUT_STAGES.map((stage) => stage.minimum_completed_outcomes),
    [1, 3, 5, 10],
  );

  const policyId = "policy-" + "a".repeat(64);
  const a = taskForSelection(policyId, true);
  const bucket = a.bucket;
  assert.ok(bucket >= 0 && bucket < 5);

  for (const traffic of [5, 20, 50, 100]) {
    const selected = deterministicCanarySelection(a.taskId, policyId, traffic);
    assert.equal(selected.selected, true);
    assert.equal(selected.bucket, bucket);
    assert.equal(selected.traffic_percent, traffic);
  }

  const outside5 = taskForSelection(policyId, false);
  assert.equal(deterministicCanarySelection(outside5.taskId, policyId, 5).selected, false);
  assert.equal(deterministicCanarySelection(outside5.taskId, policyId, 100).selected, true);
});

test("Canary eligibility fails closed for critical, Two-Key, critical-path, broad, or nonlocal tasks", () => {
  const base = safeRuntime("task-eligibility");
  assert.equal(classifyCanaryEligibility({
    taskId: base.taskId,
    state: policyState(),
    activeState: base.activeState,
    activeContract: base.activeContract,
  }).eligible, true);

  assert.equal(classifyCanaryEligibility({
    taskId: base.taskId,
    state: policyState({ criticality: "MAJOR" }),
    activeState: base.activeState,
    activeContract: base.activeContract,
  }).reason, "CANARY_NORMAL_ONLY");

  assert.equal(classifyCanaryEligibility({
    taskId: base.taskId,
    state: policyState(),
    activeState: { ...base.activeState, independentReviewRequired: true },
    activeContract: base.activeContract,
  }).reason, "CANARY_TWO_KEY_EXCLUDED");

  assert.equal(classifyCanaryEligibility({
    taskId: base.taskId,
    state: policyState(),
    activeState: { ...base.activeState, taskSpec: "Modify authentication security flow" },
    activeContract: base.activeContract,
  }).reason, "CANARY_CRITICAL_PATH_EXCLUDED");

  assert.equal(classifyCanaryEligibility({
    taskId: base.taskId,
    state: policyState(),
    activeState: base.activeState,
    activeContract: { allowedPaths: ["**"], forbiddenPaths: [] },
  }).reason, "CANARY_SCOPE_NOT_LOCAL_REVERSIBLE");

  assert.equal(classifyCanaryEligibility({
    taskId: base.taskId,
    state: policyState({ taskDomain: "INFRA" }),
    activeState: { ...base.activeState, taskDomain: "INFRA" },
    activeContract: base.activeContract,
  }).reason, "CANARY_TASK_DOMAIN_INELIGIBLE");

  assert.equal(isCanaryExternalSideEffect({
    toolName: "run_command",
    toolArgs: { CommandLine: "git push origin main" },
  }), true);
  assert.equal(isCanaryExternalSideEffect({
    toolName: "write_to_file",
    toolArgs: { path: "src/a.js" },
  }), false);
});

test("Canary cannot start without explicit human approval and a ready Shadow report", () => {
  const f = fixture();
  try {
    const denied = approveCanary({
      repoRoot: f.repo,
      shadowReportId: f.shadowReportId,
      humanApproval: false,
    });
    assert.equal(denied.approved, false);
    assert.equal(denied.reason, "EXPLICIT_HUMAN_APPROVAL_REQUIRED");

    const approved = approveFixture(f);
    assert.equal(approved.config.traffic_percent, 5);
    assert.equal(approved.config.status, "ACTIVE");
    assert.equal(approved.config.candidate_policy_id, f.candidateId);

    const active = loadCanaryConfig(f.repo);
    assert.equal(active.active, true, JSON.stringify(active));
    assert.equal(active.approval.approved_by, "HUMAN_EXPLICIT_CLI");

    assert.equal(
      existsSync(join(f.repo, ".agents", "dream-data", "shadow", "config.json")),
      false,
      "Live Canary must retire the active Shadow pointer",
    );
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("Only selected eligible task IDs receive candidate routing", () => {
  const f = fixture();
  try {
    approveFixture(f);
    const selected = taskForSelection(f.candidateId, true);
    const notSelected = taskForSelection(f.candidateId, false);
    const selectedRuntime = safeRuntime(selected.taskId);
    const outsideRuntime = safeRuntime(notSelected.taskId);

    const canary = evaluateCanaryPolicyOverlay({
      repoRoot: f.repo,
      taskId: selected.taskId,
      decisionType: "WORKER_TIER",
      state: policyState(),
      availableActions: ACTIONS,
      baselineAction: "FLASH_MEDIUM",
      baselinePolicyId: f.baselinePolicyId,
      activeState: selectedRuntime.activeState,
      activeContract: selectedRuntime.activeContract,
    });
    assert.equal(canary.active, true, JSON.stringify(canary));
    assert.equal(canary.action, "FLASH_LOW");
    assert.equal(canary.source, "CANARY_POLICY");
    assert.equal(canary.baseline_action, "FLASH_MEDIUM");
    assert.equal(canary.policy_id, f.candidateId);
    assert.ok(canary.canary_bucket < 5);

    const outside = evaluateCanaryPolicyOverlay({
      repoRoot: f.repo,
      taskId: notSelected.taskId,
      decisionType: "WORKER_TIER",
      state: policyState(),
      availableActions: ACTIONS,
      baselineAction: "FLASH_MEDIUM",
      baselinePolicyId: f.baselinePolicyId,
      activeState: outsideRuntime.activeState,
      activeContract: outsideRuntime.activeContract,
    });
    assert.equal(outside.active, false);
    assert.equal(outside.reason, "CANARY_TASK_NOT_SELECTED");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("Exact baseline-accepted candidate failure rolls Canary back after factual outcome", () => {
  const f = fixture();
  try {
    const approval = approveFixture(f);
    const selected = taskForSelection(f.candidateId, true);
    const runtime = safeRuntime(selected.taskId);
    const overlay = evaluateCanaryPolicyOverlay({
      repoRoot: f.repo,
      taskId: selected.taskId,
      decisionType: "WORKER_TIER",
      state: policyState(),
      availableActions: ACTIONS,
      baselineAction: "FLASH_MEDIUM",
      baselinePolicyId: f.baselinePolicyId,
      activeState: runtime.activeState,
      activeContract: runtime.activeContract,
    });
    assert.equal(overlay.active, true);

    const correlationKey = "canary-regression";
    const recorded = recordDecision({
      repoRoot: f.repo,
      snapshot: f.trainRoot,
      correlationKey,
      decision: {
        decision_id: "dec-h-canary-regression",
        snapshot_id: f.trainRoot,
        decision_type: "WORKER_TIER",
        state: policyState(),
        available_actions: ACTIONS,
        chosen_action: overlay.action,
        policy_source: overlay.source,
        policy_id: overlay.policy_id,
        baseline_action: overlay.baseline_action,
        policy_diagnostic: null,
        actor_identity: "ORCHESTRATOR",
        conversation_id: "canary-regression",
        step_idx: 1,
        tool_call_id: "tool-canary-regression",
        branch_ordinal: 0,
      },
    });
    assert.equal(recorded.recorded, true, JSON.stringify(recorded));

    const outcome = recordDecisionOutcome({
      repoRoot: f.repo,
      correlationKey,
      outcome: {
        result: { status: "FAILED" },
        evidence_summary: {
          tests: "NOT_REQUIRED",
          typecheck: "NOT_REQUIRED",
          build: "NOT_REQUIRED",
          scope_check: "PASS",
          validation_fresh: false,
        },
        retry_state: { retry_remaining: 0 },
        cost_metrics: { model_calls: 1, input_tokens: 10, output_tokens: 5, latency_ms: 5 },
        terminal_state: "FAILED",
        resulting_snapshot_id: null,
      },
    });
    assert.equal(outcome.recorded, true, JSON.stringify(outcome));

    const active = loadCanaryConfig(f.repo);
    assert.equal(active.active, false);
    assert.equal(active.reason, "CANARY_DISABLED");

    const report = summarizeCanarySession({
      repoRoot: f.repo,
      canarySessionId: approval.config.canary_session_id,
    });
    assert.equal(report.summarized, true, JSON.stringify(report));
    assert.equal(report.report.status, "ROLLED_BACK");
    assert.equal(report.report.exact_regression_count, 1);
    assert.equal(report.report.automatic_promotion_allowed, false);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("Progressive Canary requires human approval at 5 -> 20 -> 50 -> 100 before promotion", () => {
  const f = fixture();
  try {
    const approval = approveFixture(f);
    assert.equal(approval.config.traffic_percent, 5);
    assert.equal(approval.config.rollout_stage_index, 0);
    assert.equal(approval.config.rollout_generation, 0);

    const emptyReport = summarizeCanarySession({ repoRoot: f.repo });
    assert.equal(emptyReport.summarized, true);
    assert.equal(emptyReport.report.status, "COLLECT_CANARY_OUTCOMES");
    assert.equal(emptyReport.report.stage_gate_reason, "CANARY_ROLLOUT_NO_LIVE_DECISIONS");

    const stageCases = [
      { traffic: 5, outcomes: 1, next: 20, index: 0, start: 200000, label: "5" },
      { traffic: 20, outcomes: 3, next: 50, index: 1, start: 300000, label: "20" },
      { traffic: 50, outcomes: 5, next: 100, index: 2, start: 400000, label: "50" },
    ];

    let cumulative = 0;
    for (const stageCase of stageCases) {
      recordAcceptedCanaryOutcomes(f, {
        count: stageCase.outcomes,
        trafficPercent: stageCase.traffic,
        start: stageCase.start,
        label: stageCase.label,
      });
      cumulative += stageCase.outcomes;

      const report = summarizeCanarySession({ repoRoot: f.repo });
      assert.equal(report.summarized, true, JSON.stringify(report));
      assert.equal(report.report.status, "READY_FOR_HUMAN_STAGE_ADVANCE");
      assert.equal(report.report.traffic_percent, stageCase.traffic);
      assert.equal(report.report.rollout_stage_index, stageCase.index);
      assert.equal(report.report.executed_canary_decisions, stageCase.outcomes);
      assert.equal(report.report.completed_canary_outcomes, stageCase.outcomes);
      assert.equal(report.report.cumulative_completed_canary_outcomes, cumulative);
      assert.equal(report.report.next_traffic_percent, stageCase.next);
      assert.equal(report.report.human_stage_advance_required, true);
      assert.equal(report.report.human_promotion_required, false);
      assert.equal(report.report.automatic_stage_advance_allowed, false);
      assert.equal(report.report.automatic_promotion_allowed, false);

      const earlyPromotion = promoteCanary({
        repoRoot: f.repo,
        canaryReportId: report.report.report_id,
        humanApproval: true,
      });
      assert.equal(earlyPromotion.promoted, false);
      assert.equal(earlyPromotion.reason, "CANARY_REPORT_NOT_PROMOTABLE");

      if (stageCase.index === 0) {
        const deniedAdvance = advanceCanaryStage({
          repoRoot: f.repo,
          canaryReportId: report.report.report_id,
          humanApproval: false,
        });
        assert.equal(deniedAdvance.advanced, false);
        assert.equal(deniedAdvance.reason, "EXPLICIT_HUMAN_STAGE_APPROVAL_REQUIRED");
      }

      const advanced = advanceCanaryStage({
        repoRoot: f.repo,
        canaryReportId: report.report.report_id,
        humanApproval: true,
      });
      assert.equal(advanced.advanced, true, JSON.stringify(advanced));
      assert.equal(advanced.from_stage.traffic_percent, stageCase.traffic);
      assert.equal(advanced.to_stage.traffic_percent, stageCase.next);
      assert.equal(advanced.config.rollout_generation, stageCase.index + 1);

      const active = loadCanaryConfig(f.repo);
      assert.equal(active.active, true, JSON.stringify(active));
      assert.equal(active.config.traffic_percent, stageCase.next);
      assert.equal(active.rolloutStage.index, stageCase.index + 1);
      assert.equal(active.rolloutApproval.approved_by, "HUMAN_EXPLICIT_CLI");
      assert.equal(active.rolloutApproval.canary_report_id, report.report.report_id);

      const replayAdvance = advanceCanaryStage({
        repoRoot: f.repo,
        canaryReportId: report.report.report_id,
        humanApproval: true,
      });
      assert.equal(replayAdvance.advanced, false);
      assert.equal(replayAdvance.reason, "CANARY_STAGE_REPORT_STALE");
    }

    recordAcceptedCanaryOutcomes(f, {
      count: 10,
      trafficPercent: 100,
      start: 500000,
      label: "100",
    });
    cumulative += 10;

    const report = summarizeCanarySession({ repoRoot: f.repo });
    assert.equal(report.summarized, true, JSON.stringify(report));
    assert.equal(report.report.status, "READY_FOR_HUMAN_PROMOTION_REVIEW");
    assert.equal(report.report.traffic_percent, 100);
    assert.equal(report.report.rollout_stage_index, 3);
    assert.equal(report.report.executed_canary_decisions, 10);
    assert.equal(report.report.completed_canary_outcomes, 10);
    assert.equal(report.report.cumulative_completed_canary_outcomes, cumulative);
    assert.equal(report.report.next_traffic_percent, null);
    assert.equal(report.report.human_stage_advance_required, false);
    assert.equal(report.report.human_promotion_required, true);

    const cannotAdvanceFinal = advanceCanaryStage({
      repoRoot: f.repo,
      canaryReportId: report.report.report_id,
      humanApproval: true,
    });
    assert.equal(cannotAdvanceFinal.advanced, false);
    assert.equal(cannotAdvanceFinal.reason, "CANARY_REPORT_NOT_STAGE_ADVANCEABLE");

    const denied = promoteCanary({
      repoRoot: f.repo,
      canaryReportId: report.report.report_id,
      humanApproval: false,
    });
    assert.equal(denied.promoted, false);
    assert.equal(denied.reason, "EXPLICIT_HUMAN_PROMOTION_REQUIRED");

    const promoted = promoteCanary({
      repoRoot: f.repo,
      canaryReportId: report.report.report_id,
      humanApproval: true,
    });
    assert.equal(promoted.promoted, true, JSON.stringify(promoted));
    assert.equal(promoted.policy_id, f.candidateId);
    assert.ok(existsSync(promoted.pointer_path));
    assert.ok(existsSync(promoted.version_path));
    assert.ok(existsSync(promoted.history_path));

    const runtimePolicy = loadRuntimePolicy(f.repo);
    assert.equal(runtimePolicy.ok, true);
    assert.equal(runtimePolicy.source, "ACTIVE_POLICY");
    assert.equal(runtimePolicy.policy.policy_id, f.candidateId);

    const futureLabBaseline = loadCurrentPolicy(f.repo);
    assert.equal(futureLabBaseline.ok, true);
    assert.equal(futureLabBaseline.source, "ACTIVE_POLICY");
    assert.equal(futureLabBaseline.policy.policy_id, f.candidateId);

    const canaryAfter = loadCanaryConfig(f.repo);
    assert.equal(canaryAfter.active, false);
    assert.equal(canaryAfter.reason, "CANARY_DISABLED");

    // A Shadow report tied to the old baseline becomes stale immediately after promotion.
    const staleApproval = approveCanary({
      repoRoot: f.repo,
      shadowReportId: f.shadowReportId,
      humanApproval: true,
    });
    assert.equal(staleApproval.approved, false);
    assert.equal(staleApproval.reason, "CANARY_SHADOW_BASELINE_STALE");

    // Corrupting the pointer must never make the promoted policy authoritative.
    const pointerPath = promoted.pointer_path;
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    pointer.pointer_hash = "sha256:" + "0".repeat(64);
    writeFileSync(pointerPath, JSON.stringify(pointer, null, 2), "utf8");

    const fallback = loadRuntimePolicy(f.repo);
    assert.equal(fallback.ok, true);
    assert.equal(fallback.source, "STATIC_ROUTING_FALLBACK");
    assert.equal(fallback.diagnostic, "ACTIVE_POLICY_POINTER_INVALID");
    assert.notEqual(fallback.policy.policy_id, f.candidateId);

    // Restore the valid pointer, then prove policy rollback is separately human-gated
    // and returns authority to the exact previous baseline.
    writeFileSync(pointerPath, JSON.stringify(promoted.active_pointer, null, 2), "utf8");
    const rollbackDenied = rollbackActivePolicy({
      repoRoot: f.repo,
      humanApproval: false,
    });
    assert.equal(rollbackDenied.rolled_back, false);
    assert.equal(rollbackDenied.reason, "EXPLICIT_HUMAN_POLICY_ROLLBACK_REQUIRED");

    const rollback = rollbackActivePolicy({
      repoRoot: f.repo,
      humanApproval: true,
    });
    assert.equal(rollback.rolled_back, true, JSON.stringify(rollback));
    assert.equal(rollback.rollback_of_policy_id, f.candidateId);
    assert.equal(rollback.policy_id, f.baselinePolicyId);
    assert.equal(rollback.source, "STATIC_POLICY_V1");
    assert.ok(existsSync(rollback.history_path));

    const afterRollback = loadRuntimePolicy(f.repo);
    assert.equal(afterRollback.ok, true);
    assert.equal(afterRollback.source, "STATIC_POLICY_V1");
    assert.equal(afterRollback.policy.policy_id, f.baselinePolicyId);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});
