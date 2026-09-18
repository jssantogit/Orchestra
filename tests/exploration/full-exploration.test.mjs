import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DECISION_TYPES,
  deriveAvailableActions,
  deriveDecisionState,
  deriveValidatedStaticBaseline,
} from "../../runtimes/antigravity/.agents/dream/action-space.mjs";
import {
  FULL_EXPLORATION_LIMITS,
  fullExplorationStatus,
  prepareFullExplorationBranch,
  runFullExplorationBranch,
  startFullExploration,
  stopFullExploration,
} from "../../runtimes/antigravity/.agents/dream/full-exploration.mjs";
import {
  computePolicyId,
  evaluatePolicy,
  validatePolicy,
} from "../../runtimes/antigravity/.agents/dream/policy-engine.mjs";
import { evaluateTrajectory } from "../../runtimes/antigravity/.agents/dream/evaluator.mjs";
import { buildSnapshot } from "../../runtimes/antigravity/.agents/dream/snapshot.mjs";
import { createDreamEvent, DREAM_SCHEMAS } from "../../runtimes/antigravity/.agents/dream/records.mjs";
import { sealWorld, validateWorld } from "../../runtimes/antigravity/.agents/dream/world-sealer.mjs";
import {
  armExplorationCapture,
  captureBranchSeedIfArmed,
  prepareExploration,
} from "../../runtimes/antigravity/.agents/dream/exploration-lab.mjs";
const __dirname = dirname(fileURLToPath(import.meta.url));
const staticPolicy = JSON.parse(readFileSync(resolve(__dirname, "../../runtimes/antigravity/.agents/dream/policies/static-policy-v1.json"), "utf8"));

function controllerFixture() {
  const repo = mkdtempSync(join(tmpdir(), "orchestra-k-factual-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".agents", "hooks"), { recursive: true });
  writeFileSync(join(repo, "src", "unit.js"), "export const value = 1;\n");
  writeFileSync(join(repo, ".agents", "hooks.json"), JSON.stringify({
    "scope-enforcer": {
      PreToolUse: [{
        matcher: "write_to_file|replace_file_content|edit_file|create_file|invoke_subagent|define_subagent|run_command|manage_task|manage_subagents|schedule|send_message|view_file|grep_search|find_by_name",
        hooks: [{ type: "command", command: "node hooks/pre-tool-enforce.mjs", timeout: 10 }],
      }],
    },
  }, null, 2));
  writeFileSync(join(repo, ".agents", "hooks", "pre-tool-enforce.mjs"), "// fixture baseline hook\n");
  writeFileSync(join(repo, ".agents", "hooks", "pre-tool-exploration-guard.mjs"), "// fixture exploration wrapper\n");
  writeFileSync(join(repo, ".agents", "hooks", "post-invocation-exploration-guard.mjs"), "// fixture budget wrapper\n");

  const state = {
    task_action: "IMPLEMENT",
    task_domain: "CODE",
    criticality: "NORMAL",
    complexity: "NORMAL",
    state: "EXECUTING",
    attempt: 0,
    retry_remaining: 1,
    retry_reason: null,
    mutation_seq: 0,
    post_investigation: false,
    evidence: {
      tests: "UNKNOWN",
      typecheck: "UNKNOWN",
      build: "UNKNOWN",
      scope_check: "UNKNOWN",
      validation_fresh: false,
    },
  };
  const task = {
    task_id: "task-k-fixture",
    spec: "Milestone K factual controller fixture",
    task_action: "IMPLEMENT",
    task_domain: "CODE",
    criticality: "NORMAL",
  };
  const contract = {
    allowedPaths: ["src/**"],
    forbiddenPaths: [".agents/**"],
    criticality: "NORMAL",
    testsRequired: [],
  };
  const evidence = {
    tests: "UNKNOWN",
    typecheck: "UNKNOWN",
    build: "UNKNOWN",
    scope_check: "UNKNOWN",
    validation_fresh: false,
  };
  const snapshotResult = buildSnapshot({
    repoRoot: repo,
    task,
    contract,
    runtime: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      schema_version: DREAM_SCHEMAS.SNAPSHOT,
    },
    executionState: {
      step_sequence: 0,
      attempt: 0,
      retry_remaining: 1,
      mutation_seq: 0,
    },
    evidence,
  });
  assert.equal(snapshotResult.ok, true);

  const decision = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "decision-k-source",
    snapshot_id: snapshotResult.snapshot.snapshot_id,
    decision_type: "WORKER_TIER",
    state,
    available_actions: ["FLASH_LOW", "FLASH_MEDIUM"],
    chosen_action: "FLASH_LOW",
    policy_source: "STATIC_POLICY_V1",
    actor_identity: "ORCHESTRATOR",
    created_at: "2026-09-18T00:00:00.000Z",
    step_idx: 0,
    branch_ordinal: 0,
  });
  const outcome = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: decision.decision_id,
    observation_id: "observation-k-source",
    result: "SUCCESS",
    evidence_summary: {
      tests: "NOT_REQUIRED",
      typecheck: "NOT_REQUIRED",
      build: "NOT_REQUIRED",
      scope_check: "PASS",
      validation_fresh: false,
    },
    retry_state: { retry_remaining: 1 },
    cost_metrics: { model_calls: 1 },
    terminal_state: "ACCEPTED",
    resulting_snapshot_id: null,
    created_at: "2026-09-18T00:00:01.000Z",
  });
  const sealed = sealWorld({
    events: [decision, outcome],
    expectedRuntimeFingerprint: snapshotResult.snapshot.runtime_fingerprint,
    rootSnapshotId: snapshotResult.snapshot.snapshot_id,
    worldId: "world-k-source",
  });
  assert.equal(sealed.status, "SEALED", JSON.stringify(sealed.errors));

  const armed = armExplorationCapture({ repoRoot: repo, decisionType: "WORKER_TIER" });
  assert.equal(armed.armed, true);
  const captured = captureBranchSeedIfArmed({
    repoRoot: repo,
    snapshot: snapshotResult.snapshot,
    decisionType: "WORKER_TIER",
    decisionState: state,
    availableActions: ["FLASH_LOW", "FLASH_MEDIUM"],
    scopeContract: contract,
    taskDescriptor: task,
    evidenceSummary: evidence,
    runtimeState: { state: "EXECUTING" },
  });
  assert.equal(captured.captured, true, JSON.stringify(captured));

  return {
    repo,
    seedPath: captured.seed_path,
    world: sealed.world,
  };
}

test("full exploration hard ceilings are static and bounded", () => {
  assert.deepEqual(FULL_EXPLORATION_LIMITS, {
    max_branches: 3,
    max_parallel: 2,
    max_total_model_calls: 6,
    timeout_ms: 900000,
  });
});

test("full exploration controller persists an explicit bounded lifecycle", () => {
  const repo = mkdtempSync(join(tmpdir(), "orchestra-k-controller-"));
  try {
    const started = startFullExploration({ repoRoot: repo });
    assert.equal(started.started, true);
    assert.equal(started.control.status, "ACTIVE");
    assert.equal(started.control.branches_remaining, 3);
    assert.equal(started.control.total_model_calls, 0);

    const duplicate = startFullExploration({ repoRoot: repo });
    assert.equal(duplicate.started, false);
    assert.equal(duplicate.reason, "FULL_EXPLORATION_ALREADY_ACTIVE");

    const status = fullExplorationStatus({ repoRoot: repo });
    assert.equal(status.active, true);
    assert.equal(status.branches_started, 0);
    assert.deepEqual(status.limits, FULL_EXPLORATION_LIMITS);

    const stopped = stopFullExploration({ repoRoot: repo, reason: "TEST_COMPLETE" });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.control.status, "STOPPED");
    assert.equal(stopped.control.stop_reason, "TEST_COMPLETE");

    const finalStatus = fullExplorationStatus({ repoRoot: repo });
    assert.equal(finalStatus.active, false);
    assert.equal(finalStatus.status, "STOPPED");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("K defers control outcomes until a factual branch consequence and seals one decision per world", () => {
  const fixture = controllerFixture();
  try {
    const started = startFullExploration({ repoRoot: fixture.repo });
    assert.equal(started.started, true);

    const unauthorized = prepareExploration({
      repoRoot: fixture.repo,
      seedPath: fixture.seedPath,
      world: fixture.world,
      decisionId: "decision-k-source",
      fullExplorationContext: {
        session_id: started.control.session_id,
        branch_ordinal: 0,
        reservation_token: "forged-token",
      },
    });
    assert.equal(unauthorized.prepared, false);
    assert.equal(unauthorized.reason, "FULL_EXPLORATION_BRANCH_RESERVATION_MISSING");

    const prepared = prepareFullExplorationBranch({
      repoRoot: fixture.repo,
      seedPath: fixture.seedPath,
      world: fixture.world,
      decisionId: "decision-k-source",
    });
    assert.equal(prepared.prepared, true, JSON.stringify(prepared));
    assert.equal(prepared.branch.selected_action, "FLASH_MEDIUM");
    assert.equal(prepared.branch.deferred_decision_ids.length, 3);

    let status = fullExplorationStatus({ repoRoot: fixture.repo });
    assert.equal(status.pending_decision_outcomes, 3);
    assert.equal(status.decision_worlds.length, 0);

    const failedRun = runFullExplorationBranch({
      repoRoot: fixture.repo,
      branchId: prepared.branch.branch_id,
      command: "node",
      args: ["script.mjs"],
    });
    assert.equal(failedRun.ran, false);
    assert.equal(failedRun.branch.status, "FAILED_TO_START");
    assert.equal(failedRun.branch.decision_outcomes_finalized, true);

    status = fullExplorationStatus({ repoRoot: fixture.repo });
    assert.equal(status.pending_decision_outcomes, 0);
    assert.equal(status.decision_worlds.length, 3);

    const control = JSON.parse(readFileSync(join(
      fixture.repo,
      ".agents",
      "dream-data",
      "full-exploration",
      "control.json",
    ), "utf8"));
    const completed = control.decisions.filter((item) => item.outcome_status === "COMPLETE");
    assert.equal(completed.length, 3);
    for (const decision of completed) {
      const world = JSON.parse(readFileSync(decision.outcome_world_path, "utf8"));
      assert.equal(validateWorld(world).valid, true);
      assert.equal(world.decisions.length, 1);
      assert.equal(world.outcomes.length, 1);
      assert.equal(world.decisions[0].decision_type, decision.decision_type);
      assert.equal(world.outcomes[0].terminal_state, "UNKNOWN");
      assert.equal(world.outcomes[0].result.attributable, false);
    }
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test("K namespacing permits another attempt but never repeats the same unknown action for one source decision", () => {
  const fixture = controllerFixture();
  try {
    assert.equal(startFullExploration({ repoRoot: fixture.repo }).started, true);
    const first = prepareFullExplorationBranch({
      repoRoot: fixture.repo,
      seedPath: fixture.seedPath,
      world: fixture.world,
      decisionId: "decision-k-source",
    });
    assert.equal(first.prepared, true, JSON.stringify(first));
    assert.equal(first.branch.selected_action, "FLASH_MEDIUM");

    const failedRun = runFullExplorationBranch({
      repoRoot: fixture.repo,
      branchId: first.branch.branch_id,
      command: "node",
      args: ["script.mjs"],
    });
    assert.equal(failedRun.ran, false);

    const second = prepareFullExplorationBranch({
      repoRoot: fixture.repo,
      seedPath: fixture.seedPath,
      world: fixture.world,
      decisionId: "decision-k-source",
    });
    assert.equal(second.prepared, false);
    assert.equal(second.reason, "NO_UNKNOWN_BRANCH");
    assert.equal(second.branch.status, "FAILED_TO_START");
    assert.equal(second.branch.selected_action, null);

    const status = fullExplorationStatus({ repoRoot: fixture.repo });
    assert.equal(status.branches_started, 2);
    assert.equal(status.branches_remaining, 1);
    assert.equal(status.pending_decision_outcomes, 0);
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test("unattributable K infrastructure outcomes become insufficient support, not negative evidence", () => {
  const evaluated = evaluateTrajectory({
    status: "EXACT_REPLAY_COMPLETE",
    terminal_state: "UNKNOWN",
    steps: [{
      decision_type: "EXPLORATION_BRANCHING",
      chosen_action: "OPEN_BRANCH",
      result: {
        factual: true,
        attributable: false,
        support_status: "INSUFFICIENT_SUPPORT",
        reason: "EXPLORATION_ANTIGRAVITY_EXECUTABLE_NOT_FOUND",
      },
      terminal_state: "UNKNOWN",
      cost_metrics: { model_calls: 0 },
    }],
  });
  assert.equal(evaluated.eligible, true);
  assert.equal(evaluated.has_unknown_branch, true);
  assert.equal(evaluated.terminal_state, "UNKNOWN_BRANCH");
  assert.equal(evaluated.accepted, false);
});

test("K action spaces fail closed at budget and criticality boundaries", () => {
  const normal = {
    criticality: "NORMAL",
    state: "EXECUTING",
    exploration_branches_active: 0,
    exploration_branches_remaining: 3,
    branch_feedback_status: "UNKNOWN",
    branch_invalid: false,
  };
  assert.deepEqual(
    deriveAvailableActions(DECISION_TYPES.EXPLORATION_BRANCHING, normal),
    ["NO_NEW_BRANCH", "OPEN_BRANCH"],
  );
  assert.deepEqual(
    deriveAvailableActions(DECISION_TYPES.PARALLELISM, normal),
    ["SERIAL", "PARALLEL_2"],
  );

  const exhausted = { ...normal, exploration_branches_remaining: 0 };
  assert.deepEqual(deriveAvailableActions(DECISION_TYPES.EXPLORATION_BRANCHING, exhausted), ["NO_NEW_BRANCH"]);
  assert.deepEqual(deriveAvailableActions(DECISION_TYPES.STOPPING, exhausted), ["STOP_EXPLORATION"]);

  const critical = { ...normal, criticality: "CRITICAL" };
  assert.deepEqual(deriveAvailableActions(DECISION_TYPES.EXPLORATION_BRANCHING, critical), ["NO_NEW_BRANCH"]);
  assert.deepEqual(deriveAvailableActions(DECISION_TYPES.STOPPING, critical), ["STOP_EXPLORATION"]);
});

test("pruning becomes legal only for factual invalid/falsified branch state", () => {
  const base = {
    criticality: "NORMAL",
    state: "EXECUTING",
    exploration_branches_remaining: 1,
    branch_feedback_status: "SUPPORTED",
    branch_invalid: false,
  };
  assert.deepEqual(deriveAvailableActions(DECISION_TYPES.PRUNE_BRANCH, base), ["KEEP_BRANCH"]);
  assert.deepEqual(
    deriveAvailableActions(DECISION_TYPES.PRUNE_BRANCH, { ...base, branch_feedback_status: "FALSIFIED" }),
    ["KEEP_BRANCH", "PRUNE_BRANCH"],
  );
  assert.deepEqual(
    deriveAvailableActions(DECISION_TYPES.PRUNE_BRANCH, { ...base, branch_invalid: true }),
    ["KEEP_BRANCH", "PRUNE_BRANCH"],
  );
});

test("policy engine validates and evaluates K rules without exceeding legal action set", () => {
  assert.equal(validatePolicy(staticPolicy).valid, true);
  assert.equal(computePolicyId(staticPolicy), staticPolicy.policy_id);

  const state = {
    task_action: "INVESTIGATE",
    task_domain: "RESEARCH",
    criticality: "NORMAL",
    complexity: "EXPERIMENTAL",
    state: "EXECUTING",
    attempt: 0,
    retry_remaining: 0,
    retry_reason: null,
    mutation_seq: 0,
    post_investigation: false,
    evidence: { tests: "UNKNOWN", typecheck: "UNKNOWN", build: "UNKNOWN", scope_check: "UNKNOWN", validation_fresh: false },
    exploration_branches_started: 0,
    exploration_branches_active: 0,
    exploration_branches_remaining: 3,
    feedback_unknown: 0,
    feedback_observed: 0,
    feedback_supported: 0,
    feedback_falsified: 0,
    feedback_causal: 0,
    branch_feedback_status: "UNKNOWN",
    branch_invalid: false,
  };
  const legal = deriveAvailableActions(DECISION_TYPES.EXPLORATION_BRANCHING, state);
  const baseline = deriveValidatedStaticBaseline({ decisionType: DECISION_TYPES.EXPLORATION_BRANCHING, state });
  const result = evaluatePolicy({
    policy: staticPolicy,
    decisionType: DECISION_TYPES.EXPLORATION_BRANCHING,
    state,
    availableActions: legal,
    baselineAction: baseline,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, "OPEN_BRANCH");

  const exhausted = { ...state, exploration_branches_remaining: 0 };
  const exhaustedResult = evaluatePolicy({
    policy: staticPolicy,
    decisionType: DECISION_TYPES.EXPLORATION_BRANCHING,
    state: exhausted,
    availableActions: deriveAvailableActions(DECISION_TYPES.EXPLORATION_BRANCHING, exhausted),
    baselineAction: "NO_NEW_BRANCH",
  });
  assert.equal(exhaustedResult.ok, true);
  assert.equal(exhaustedResult.action, "NO_NEW_BRANCH");
});

test("decision state exposes only bounded aggregate feedback/exploration facts", () => {
  const state = deriveDecisionState({}, {
    state: "EXECUTING",
    criticality: "NORMAL",
    feedbackSummary: {
      status_counts: { UNKNOWN: 2, OBSERVED: 1, SUPPORTED: 3, FALSIFIED: 1, CAUSALLY_VERIFIED: 1 },
    },
    explorationControl: {
      max_branches: 3,
      branches_started: 1,
      branches_active: 1,
      branches_remaining: 2,
      branch_feedback_status: "SUPPORTED",
      branch_invalid: false,
    },
  });
  assert.equal(state.feedback_supported, 3);
  assert.equal(state.feedback_causal, 1);
  assert.equal(state.exploration_branches_remaining, 2);
  assert.equal(state.branch_feedback_status, "SUPPORTED");
  assert.equal(Object.prototype.hasOwnProperty.call(state, "raw_feedback"), false);
});
