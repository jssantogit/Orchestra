import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DECISION_TYPES,
  deriveAvailableActions,
  deriveDecisionState,
  deriveValidatedStaticBaseline,
} from "../../runtimes/antigravity/.agents/dream/action-space.mjs";
import {
  FULL_EXPLORATION_LIMITS,
} from "../../runtimes/antigravity/.agents/dream/full-exploration.mjs";
import {
  computePolicyId,
  evaluatePolicy,
  validatePolicy,
} from "../../runtimes/antigravity/.agents/dream/policy-engine.mjs";
const __dirname = dirname(fileURLToPath(import.meta.url));
const staticPolicy = JSON.parse(readFileSync(resolve(__dirname, "../../runtimes/antigravity/.agents/dream/policies/static-policy-v1.json"), "utf8"));

test("full exploration hard ceilings are static and bounded", () => {
  assert.deepEqual(FULL_EXPLORATION_LIMITS, {
    max_branches: 3,
    max_parallel: 2,
    max_total_model_calls: 6,
    timeout_ms: 900000,
  });
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
