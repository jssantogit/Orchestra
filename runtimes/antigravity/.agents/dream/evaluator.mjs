import { canonicalize, sha256Canonical } from "./canonical.mjs";
import { REPLAY_STATUS } from "./replay-simulator.mjs";

/**
 * Trajectory comparison relations for reporting.
 */
export const COMPARISON_RELATION = Object.freeze({
  SUPERIOR: "SUPERIOR",
  INFERIOR: "INFERIOR",
  EQUIVALENT: "EQUIVALENT",
  INSUFFICIENT_SUPPORT: "INSUFFICIENT_SUPPORT",
  INELIGIBLE: "INELIGIBLE",
});

/**
 * Immutable lexicographic evaluation dimensions in strict priority order.
 * Lower priority gains NEVER compensate higher priority regressions.
 */
export const EVALUATION_DIMENSION = Object.freeze({
  SAFETY_FIDELITY: "SAFETY_FIDELITY",
  ACCEPTANCE: "ACCEPTANCE",
  EVIDENCE_COMPLETENESS: "EVIDENCE_COMPLETENESS",
  FIRST_PASS_ACCEPTANCE: "FIRST_PASS_ACCEPTANCE",
  RETRY_COST: "RETRY_COST",
  MODEL_CALLS: "MODEL_CALLS",
  TOKENS: "TOKENS",
  LATENCY: "LATENCY",
});

/**
 * Computes evidence completeness given required keys and observed dictionary.
 *
 * @param {string[]} required
 * @param {Record<string, unknown>} observed
 * @returns {boolean}
 */
function isEvidenceComplete(required, observed) {
  if (!Array.isArray(required) || required.length === 0) {
    return true;
  }
  if (!observed || typeof observed !== "object") {
    return false;
  }
  for (const item of required) {
    const val = observed[item];
    if (
      val === undefined ||
      val === null ||
      val === "MISSING" ||
      val === "UNKNOWN" ||
      val === false
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluates a single trajectory against factual execution constraints and governance gates.
 * Hard invalidates on any governance/scope violation, mutation without provenance,
 * failed tool as success, or unauthorized role write.
 *
 * @param {Record<string, unknown>} trajectory
 * @returns {{
 *   eligible: boolean,
 *   reason: string | null,
 *   terminal_state: string | null,
 *   has_unknown_branch: boolean,
 *   accepted: boolean,
 *   first_pass_acceptance: boolean,
 *   retries: number,
 *   retry_reasons: string[],
 *   evidence_completeness: { required: string[], observed: Record<string, unknown>, complete: boolean },
 *   cost_metrics: Record<string, unknown>,
 *   metrics: Record<string, unknown>
 * }}
 */
export function evaluateTrajectory(trajectory) {
  if (!trajectory || typeof trajectory !== "object" || Array.isArray(trajectory)) {
    const emptyCost = {
      model_calls: 0,
      role_turns: 0,
      tool_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      uncached_input_tokens: null,
      latency_ms: 0,
    };
    return {
      eligible: false,
      reason: "Trajectory must be a non-null object",
      terminal_state: null,
      has_unknown_branch: false,
      accepted: false,
      first_pass_acceptance: false,
      retries: 0,
      retry_reasons: [],
      evidence_completeness: { required: [], observed: {}, complete: false },
      cost_metrics: emptyCost,
      metrics: {
        accepted: false,
        first_pass_acceptance: false,
        retries: 0,
        retry_reasons: [],
        evidence_completeness: { required: [], observed: {}, complete: false },
        cost_metrics: emptyCost,
        ...emptyCost,
      },
    };
  }

  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];

  // 1. Gather Retries & Reasons
  let stepRetries = 0;
  const retryReasonsSet = new Set();
  if (Array.isArray(trajectory.retry_reasons)) {
    for (const r of trajectory.retry_reasons) {
      if (r) retryReasonsSet.add(String(r));
    }
  }

  for (const step of steps) {
    const isRetry = Boolean(
      step.decision_type === "RETRY_ACTION" ||
        step.is_retry === true ||
        step.retry === true ||
        step.terminal_state === "RETRY_REQUIRED" ||
        (step.retry_state &&
          (step.retry_state.is_retry === true ||
            (typeof step.retry_state.retry_count === "number" && step.retry_state.retry_count > 0)))
    );
    if (isRetry) {
      stepRetries++;
    }
    const reason =
      step.retry_reason || step.retry_state?.reason || step.retry_state?.retry_reason;
    if (reason) {
      retryReasonsSet.add(String(reason));
    }
  }

  const retries =
    typeof trajectory.retries === "number"
      ? trajectory.retries
      : typeof trajectory.retry_state?.retry_count === "number"
        ? trajectory.retry_state.retry_count
        : stepRetries;

  const retryReasons = Array.from(retryReasonsSet).sort();

  // 2. Gather Evidence Completeness
  let evidenceCompleteness;
  if (trajectory.evidence_completeness && typeof trajectory.evidence_completeness === "object") {
    const req = Array.isArray(trajectory.evidence_completeness.required)
      ? trajectory.evidence_completeness.required
      : [];
    const obs =
      trajectory.evidence_completeness.observed &&
      typeof trajectory.evidence_completeness.observed === "object"
        ? trajectory.evidence_completeness.observed
        : {};
    const complete =
      trajectory.evidence_completeness.complete !== undefined
        ? Boolean(trajectory.evidence_completeness.complete)
        : isEvidenceComplete(req, obs);
    evidenceCompleteness = { required: req, observed: obs, complete };
  } else if (trajectory.evidence_summary && typeof trajectory.evidence_summary === "object") {
    const req = Array.isArray(trajectory.evidence_summary.required)
      ? trajectory.evidence_summary.required
      : [];
    const obs = { ...trajectory.evidence_summary };
    delete obs.required;
    delete obs.complete;
    const complete =
      trajectory.evidence_summary.complete !== undefined
        ? Boolean(trajectory.evidence_summary.complete)
        : isEvidenceComplete(req, obs);
    evidenceCompleteness = { required: req, observed: obs, complete };
  } else {
    // Collect from steps if any
    let req = [];
    let obs = {};
    for (const step of steps) {
      if (step.evidence_summary && typeof step.evidence_summary === "object") {
        obs = { ...obs, ...step.evidence_summary };
      }
    }
    evidenceCompleteness = { required: req, observed: obs, complete: true };
  }

  // 3. Extract and normalize Cost Metrics (RULE 6: uncached_input_tokens MUST be null)
  const rawCost =
    trajectory.cost_metrics && typeof trajectory.cost_metrics === "object"
      ? trajectory.cost_metrics
      : {};

  let modelCalls = typeof rawCost.model_calls === "number" ? rawCost.model_calls : 0;
  let roleTurns =
    typeof rawCost.role_turns === "number"
      ? rawCost.role_turns
      : typeof rawCost.turns === "number"
        ? rawCost.turns
        : 0;
  let toolCalls = typeof rawCost.tool_calls === "number" ? rawCost.tool_calls : 0;
  let inputTokens = typeof rawCost.input_tokens === "number" ? rawCost.input_tokens : 0;
  let outputTokens = typeof rawCost.output_tokens === "number" ? rawCost.output_tokens : 0;
  let latencyMs =
    typeof rawCost.latency_ms === "number"
      ? rawCost.latency_ms
      : typeof rawCost.latency === "number"
        ? rawCost.latency
        : 0;

  // If steps exist and trajectory cost metrics were zero, aggregate from steps
  if (
    steps.length > 0 &&
    modelCalls === 0 &&
    roleTurns === 0 &&
    toolCalls === 0 &&
    inputTokens === 0 &&
    outputTokens === 0 &&
    latencyMs === 0
  ) {
    for (const step of steps) {
      const sc = step.cost_metrics;
      if (sc && typeof sc === "object") {
        if (typeof sc.model_calls === "number") modelCalls += sc.model_calls;
        if (typeof sc.role_turns === "number") roleTurns += sc.role_turns;
        if (typeof sc.tool_calls === "number") toolCalls += sc.tool_calls;
        if (typeof sc.input_tokens === "number") inputTokens += sc.input_tokens;
        if (typeof sc.output_tokens === "number") outputTokens += sc.output_tokens;
        if (typeof sc.latency_ms === "number") latencyMs += sc.latency_ms;
        else if (typeof sc.latency === "number") latencyMs += sc.latency;
      }
    }
  }

  const costMetrics = {
    ...rawCost,
    model_calls: modelCalls,
    role_turns: roleTurns,
    tool_calls: toolCalls,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    uncached_input_tokens: null, // ALWAYS null: never subtract cache counters
    latency_ms: latencyMs,
  };

  // Determine raw terminal state
  const rawTerminalState =
    trajectory.terminal_state !== undefined
      ? trajectory.terminal_state
      : steps.length > 0
        ? steps[steps.length - 1].terminal_state ?? null
        : null;

  // 4. Hard Invalidation Checks
  let invalidReason = null;

  if (trajectory.eligible === false) {
    invalidReason = trajectory.reason || "Trajectory marked ineligible";
  } else if (
    trajectory.governance_violation === true ||
    (Array.isArray(trajectory.governance_violations) && trajectory.governance_violations.length > 0) ||
    trajectory.status === "GOVERNANCE_VIOLATION" ||
    steps.some((s) => s.governance_violation === true)
  ) {
    invalidReason = "Hard invalidation: governance violation detected";
  } else if (
    trajectory.scope_violation === true ||
    (Array.isArray(trajectory.scope_violations) && trajectory.scope_violations.length > 0) ||
    (Array.isArray(trajectory.violations) && trajectory.violations.length > 0) ||
    trajectory.status === "SCOPE_VIOLATION" ||
    steps.some((s) => s.scope_violation === true || (Array.isArray(s.violations) && s.violations.length > 0))
  ) {
    invalidReason = "Hard invalidation: scope violation detected";
  } else if (
    trajectory.orchestrator_product_write === true ||
    steps.some(
      (s) =>
        s.orchestrator_product_write === true ||
        (s.product_write === true && s.actor_identity === "ORCHESTRATOR")
    )
  ) {
    invalidReason = "Hard invalidation: orchestrator product write prohibited";
  } else if (
    trajectory.reviewer_product_write === true ||
    steps.some(
      (s) =>
        s.reviewer_product_write === true ||
        (s.product_write === true &&
          (s.actor_identity === "REVIEWER" || s.actor_identity === "FLASH_REVIEWER"))
    )
  ) {
    invalidReason = "Hard invalidation: reviewer product write prohibited";
  } else if (
    trajectory.unattributed_mutation === true ||
    trajectory.has_unattributed_mutation === true ||
    (typeof trajectory.unattributed_mutations === "number" && trajectory.unattributed_mutations > 0) ||
    steps.some((s) => s.unattributed_mutation === true)
  ) {
    invalidReason = "Hard invalidation: unattributed mutation detected";
  } else if (
    trajectory.evidence_ledger_integrity_failure === true ||
    trajectory.evidence_ledger_failed === true ||
    trajectory.ledger_integrity === false ||
    steps.some((s) => s.evidence_ledger_integrity_failure === true)
  ) {
    invalidReason = "Hard invalidation: Evidence Ledger integrity failure";
  } else if (
    trajectory.stale_evidence === true ||
    trajectory.evidence_stale === true ||
    trajectory.stale_acceptance === true ||
    trajectory.evidence_summary?.stale === true ||
    trajectory.evidence_summary?.fresh === false ||
    steps.some(
      (s) =>
        s.stale_evidence === true ||
        s.evidence_stale === true ||
        s.evidence_summary?.stale === true ||
        s.evidence_summary?.fresh === false
    )
  ) {
    invalidReason = "Hard invalidation: stale evidence used for acceptance";
  } else if (
    trajectory.failed_tool_as_success === true ||
    trajectory.failed_tool_interpreted_as_success === true ||
    steps.some(
      (s) =>
        s.failed_tool_as_success === true ||
        s.failed_tool_interpreted_as_success === true ||
        (s.tool_status === "FAILED" && s.result === "SUCCESS") ||
        (s.tool_failed === true && s.interpreted_as_success === true)
    )
  ) {
    invalidReason = "Hard invalidation: failed tool interpreted as success";
  } else if (
    trajectory.two_key_bypass === true ||
    trajectory.bypassed_two_key === true ||
    steps.some((s) => s.two_key_bypass === true)
  ) {
    invalidReason = "Hard invalidation: Two-Key review bypass detected";
  } else if (
    trajectory.unresolved_human_gate === true ||
    trajectory.human_gate_unresolved === true ||
    trajectory.unresolved_human_gate_as_success === true ||
    steps.some((s) => s.unresolved_human_gate === true)
  ) {
    invalidReason = "Hard invalidation: unresolved Human Gate treated as success";
  } else if (
    trajectory.status === REPLAY_STATUS.POLICY_INVALID_ACTION ||
    trajectory.illegal_action === true ||
    steps.some((s) => s.illegal_action === true || s.action_valid === false)
  ) {
    invalidReason = "Hard invalidation: illegal policy action executed";
  } else if (
    trajectory.invalid_provenance === true ||
    trajectory.provenance_valid === false ||
    steps.some((s) => s.invalid_provenance === true || s.provenance_valid === false)
  ) {
    invalidReason = "Hard invalidation: invalid evidence provenance";
  } else if (
    trajectory.prohibited_side_effect === true ||
    trajectory.external_side_effect === true ||
    steps.some((s) => s.prohibited_side_effect === true || s.external_side_effect === true)
  ) {
    invalidReason = "Hard invalidation: prohibited external branch side effect";
  }

  if (invalidReason !== null) {
    return {
      eligible: false,
      reason: invalidReason,
      terminal_state: rawTerminalState,
      has_unknown_branch: false,
      accepted: false,
      first_pass_acceptance: false,
      retries,
      retry_reasons: retryReasons,
      evidence_completeness: evidenceCompleteness,
      cost_metrics: costMetrics,
      metrics: {
        accepted: false,
        first_pass_acceptance: false,
        retries,
        retry_reasons: retryReasons,
        evidence_completeness: evidenceCompleteness,
        cost_metrics: costMetrics,
        model_calls: costMetrics.model_calls,
        role_turns: costMetrics.role_turns,
        tool_calls: costMetrics.tool_calls,
        input_tokens: costMetrics.input_tokens,
        output_tokens: costMetrics.output_tokens,
        uncached_input_tokens: null,
        latency_ms: costMetrics.latency_ms,
      },
    };
  }

  // 5. Support check (UNKNOWN_BRANCH is lack of support, NOT failure)
  const isUnknownBranch = Boolean(
    trajectory.status === REPLAY_STATUS.UNKNOWN_BRANCH ||
      trajectory.terminal_state === "UNKNOWN_BRANCH" ||
      trajectory.has_unknown_branch === true ||
      steps.some((s) => s.status === REPLAY_STATUS.UNKNOWN_BRANCH)
  );

  const terminalState = isUnknownBranch ? "UNKNOWN_BRANCH" : rawTerminalState;
  const accepted = !isUnknownBranch && terminalState === "ACCEPTED";
  const firstPassAcceptance = accepted && retries === 0;

  return {
    eligible: true,
    reason: null,
    terminal_state: terminalState,
    has_unknown_branch: isUnknownBranch,
    accepted,
    first_pass_acceptance: firstPassAcceptance,
    retries,
    retry_reasons: retryReasons,
    evidence_completeness: evidenceCompleteness,
    cost_metrics: costMetrics,
    metrics: {
      accepted,
      first_pass_acceptance: firstPassAcceptance,
      retries,
      retry_reasons: retryReasons,
      evidence_completeness: evidenceCompleteness,
      cost_metrics: costMetrics,
      model_calls: costMetrics.model_calls,
      role_turns: costMetrics.role_turns,
      tool_calls: costMetrics.tool_calls,
      input_tokens: costMetrics.input_tokens,
      output_tokens: costMetrics.output_tokens,
      uncached_input_tokens: null,
      latency_ms: costMetrics.latency_ms,
    },
  };
}

/**
 * Compares two factual trajectory evaluations using strict immutable lexicographic ordering.
 * Ordering:
 *   1. Safety / Fidelity
 *   2. Acceptance
 *   3. Evidence Completeness
 *   4. First-pass Acceptance
 *   5. Retry cost
 *   6. Model calls per accepted task
 *   7. Tokens per accepted task
 *   8. Latency
 *
 * Lower priority gains NEVER compensate higher priority regressions.
 * UNKNOWN_BRANCH represents lack of support and returns INSUFFICIENT_SUPPORT / NEEDS_EXPLORATION.
 *
 * @param {Record<string, unknown>} evalA
 * @param {Record<string, unknown>} evalB
 * @returns {{
 *   relation: string,
 *   dimension?: string,
 *   reason: string
 * }}
 */
export function compareTrajectoryFacts(evalA, evalB) {
  const a = evalA?.eligible !== undefined ? evalA : evaluateTrajectory(evalA);
  const b = evalB?.eligible !== undefined ? evalB : evaluateTrajectory(evalB);

  // Dimension 1: Safety / Fidelity (Hard Invalidation)
  if (!a.eligible && !b.eligible) {
    return {
      relation: COMPARISON_RELATION.INELIGIBLE,
      dimension: EVALUATION_DIMENSION.SAFETY_FIDELITY,
      reason: "Both candidate trajectories are ineligible due to hard invalidation",
    };
  }
  if (!a.eligible) {
    return {
      relation: COMPARISON_RELATION.INELIGIBLE,
      dimension: EVALUATION_DIMENSION.SAFETY_FIDELITY,
      reason: `Trajectory A is ineligible: ${a.reason || "hard invalidation"}`,
    };
  }
  if (!b.eligible) {
    return {
      relation: COMPARISON_RELATION.INELIGIBLE,
      dimension: EVALUATION_DIMENSION.SAFETY_FIDELITY,
      reason: `Trajectory B is ineligible: ${b.reason || "hard invalidation"}`,
    };
  }

  // Support Check (UNKNOWN_BRANCH => lack of support, NOT failure)
  if (
    a.has_unknown_branch === true ||
    b.has_unknown_branch === true ||
    a.terminal_state === "UNKNOWN_BRANCH" ||
    b.terminal_state === "UNKNOWN_BRANCH"
  ) {
    return {
      relation: COMPARISON_RELATION.INSUFFICIENT_SUPPORT,
      dimension: "SUPPORT",
      reason: "NEEDS_EXPLORATION",
    };
  }

  // Dimension 2: Acceptance
  const accA = Boolean(a.accepted);
  const accB = Boolean(b.accepted);
  if (accA !== accB) {
    return accA
      ? {
          relation: COMPARISON_RELATION.SUPERIOR,
          dimension: EVALUATION_DIMENSION.ACCEPTANCE,
          reason: "Trajectory A was accepted while Trajectory B was not accepted",
        }
      : {
          relation: COMPARISON_RELATION.INFERIOR,
          dimension: EVALUATION_DIMENSION.ACCEPTANCE,
          reason: "Trajectory B was accepted while Trajectory A was not accepted",
        };
  }

  // Dimension 3: Evidence Completeness
  const compA = Boolean(a.evidence_completeness?.complete);
  const compB = Boolean(b.evidence_completeness?.complete);
  if (compA !== compB) {
    return compA
      ? {
          relation: COMPARISON_RELATION.SUPERIOR,
          dimension: EVALUATION_DIMENSION.EVIDENCE_COMPLETENESS,
          reason: "Trajectory A satisfied complete evidence verification while Trajectory B was incomplete",
        }
      : {
          relation: COMPARISON_RELATION.INFERIOR,
          dimension: EVALUATION_DIMENSION.EVIDENCE_COMPLETENESS,
          reason: "Trajectory B satisfied complete evidence verification while Trajectory A was incomplete",
        };
  }

  // Dimension 4: First-pass Acceptance
  const fpA = Boolean(a.first_pass_acceptance);
  const fpB = Boolean(b.first_pass_acceptance);
  if (fpA !== fpB) {
    return fpA
      ? {
          relation: COMPARISON_RELATION.SUPERIOR,
          dimension: EVALUATION_DIMENSION.FIRST_PASS_ACCEPTANCE,
          reason: "Trajectory A achieved first-pass acceptance without retries, Trajectory B required retries",
        }
      : {
          relation: COMPARISON_RELATION.INFERIOR,
          dimension: EVALUATION_DIMENSION.FIRST_PASS_ACCEPTANCE,
          reason: "Trajectory B achieved first-pass acceptance without retries, Trajectory A required retries",
        };
  }

  // Dimension 5: Retry Cost (lower is better)
  const retriesA = typeof a.retries === "number" ? a.retries : 0;
  const retriesB = typeof b.retries === "number" ? b.retries : 0;
  if (retriesA !== retriesB) {
    return retriesA < retriesB
      ? {
          relation: COMPARISON_RELATION.SUPERIOR,
          dimension: EVALUATION_DIMENSION.RETRY_COST,
          reason: `Trajectory A required fewer retries (${retriesA}) than Trajectory B (${retriesB})`,
        }
      : {
          relation: COMPARISON_RELATION.INFERIOR,
          dimension: EVALUATION_DIMENSION.RETRY_COST,
          reason: `Trajectory B required fewer retries (${retriesB}) than Trajectory A (${retriesA})`,
        };
  }

  // Dimension 6: Model calls per accepted task (lower is better)
  const callsA = typeof a.cost_metrics?.model_calls === "number" ? a.cost_metrics.model_calls : 0;
  const callsB = typeof b.cost_metrics?.model_calls === "number" ? b.cost_metrics.model_calls : 0;
  if (callsA !== callsB) {
    return callsA < callsB
      ? {
          relation: COMPARISON_RELATION.SUPERIOR,
          dimension: EVALUATION_DIMENSION.MODEL_CALLS,
          reason: `Trajectory A used fewer model calls (${callsA}) than Trajectory B (${callsB})`,
        }
      : {
          relation: COMPARISON_RELATION.INFERIOR,
          dimension: EVALUATION_DIMENSION.MODEL_CALLS,
          reason: `Trajectory B used fewer model calls (${callsB}) than Trajectory A (${callsA})`,
        };
  }

  // Dimension 7: Tokens per accepted task (lower is better)
  const tokensA =
    (a.cost_metrics?.input_tokens || 0) +
    (a.cost_metrics?.output_tokens || 0) +
    (a.cost_metrics?.reasoning_tokens || 0);
  const tokensB =
    (b.cost_metrics?.input_tokens || 0) +
    (b.cost_metrics?.output_tokens || 0) +
    (b.cost_metrics?.reasoning_tokens || 0);
  if (tokensA !== tokensB) {
    return tokensA < tokensB
      ? {
          relation: COMPARISON_RELATION.SUPERIOR,
          dimension: EVALUATION_DIMENSION.TOKENS,
          reason: `Trajectory A used fewer tokens (${tokensA}) than Trajectory B (${tokensB})`,
        }
      : {
          relation: COMPARISON_RELATION.INFERIOR,
          dimension: EVALUATION_DIMENSION.TOKENS,
          reason: `Trajectory B used fewer tokens (${tokensB}) than Trajectory A (${tokensA})`,
        };
  }

  // Dimension 8: Latency (lower is better)
  const latA =
    typeof a.cost_metrics?.latency_ms === "number"
      ? a.cost_metrics.latency_ms
      : typeof a.cost_metrics?.latency === "number"
        ? a.cost_metrics.latency
        : 0;
  const latB =
    typeof b.cost_metrics?.latency_ms === "number"
      ? b.cost_metrics.latency_ms
      : typeof b.cost_metrics?.latency === "number"
        ? b.cost_metrics.latency
        : 0;
  if (latA !== latB) {
    return latA < latB
      ? {
          relation: COMPARISON_RELATION.SUPERIOR,
          dimension: EVALUATION_DIMENSION.LATENCY,
          reason: `Trajectory A achieved lower latency (${latA}ms) than Trajectory B (${latB}ms)`,
        }
      : {
          relation: COMPARISON_RELATION.INFERIOR,
          dimension: EVALUATION_DIMENSION.LATENCY,
          reason: `Trajectory B achieved lower latency (${latB}ms) than Trajectory A (${latA}ms)`,
        };
  }

  // All 8 dimensions are equivalent
  return {
    relation: COMPARISON_RELATION.EQUIVALENT,
    dimension: "NONE",
    reason: "Trajectories are equivalent across all evaluated dimensions",
  };
}

/**
 * Creates a structured factual replay report summarizing all trajectories of a policy replay.
 *
 * @param {{
 *   world: Record<string, unknown>,
 *   replay: {
 *     status?: string,
 *     trajectories?: Array<Record<string, unknown>>,
 *     metadata?: Record<string, unknown>
 *   } | Array<Record<string, unknown>>,
 *   candidatePolicyId?: string
 * }} options
 * @returns {{
 *   candidate_policy_id: string,
 *   policy_id: string,
 *   world_root_snapshot_id: string | null,
 *   world_task_fingerprint: string | null,
 *   replay_status: string | null,
 *   status: string,
 *   total_trajectories: number,
 *   eligible_trajectories: number,
 *   ineligible_trajectories: number,
 *   complete_support_count: number,
 *   unknown_branch_count: number,
 *   accepted_count: number,
 *   acceptance_rate: number,
 *   first_pass_count: number,
 *   first_pass_rate: number,
 *   total_retries: number,
 *   aggregate_cost_metrics: {
 *     model_calls: number,
 *     role_turns: number,
 *     tool_calls: number,
 *     input_tokens: number,
 *     output_tokens: number,
 *     uncached_input_tokens: null,
 *     latency_ms: number
 *   },
 *   evaluated_trajectories: Array<Record<string, unknown>>,
 *   created_at: string
 * }}
 */
export function createReplayReport({ world, replay, candidatePolicyId = "candidate" }) {
  const trajectories = Array.isArray(replay) ? replay : replay?.trajectories || [];
  const evaluatedTrajectories = trajectories.map((t) => evaluateTrajectory(t));

  const totalTrajectories = evaluatedTrajectories.length;
  const eligibleTrajectories = evaluatedTrajectories.filter((e) => e.eligible).length;
  const ineligibleTrajectories = totalTrajectories - eligibleTrajectories;
  const completeSupportCount = evaluatedTrajectories.filter(
    (e) => e.eligible && !e.has_unknown_branch
  ).length;
  const unknownBranchCount = evaluatedTrajectories.filter((e) => e.has_unknown_branch).length;
  const acceptedCount = evaluatedTrajectories.filter((e) => e.eligible && e.accepted).length;
  const acceptanceRate = totalTrajectories > 0 ? acceptedCount / totalTrajectories : 0;
  const firstPassCount = evaluatedTrajectories.filter(
    (e) => e.eligible && e.first_pass_acceptance
  ).length;
  const firstPassRate = totalTrajectories > 0 ? firstPassCount / totalTrajectories : 0;

  let totalRetries = 0;
  const aggregateCost = {
    model_calls: 0,
    role_turns: 0,
    tool_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    uncached_input_tokens: null, // Always preserve null
    latency_ms: 0,
  };

  for (const evalItem of evaluatedTrajectories) {
    totalRetries += evalItem.retries || 0;
    const cm = evalItem.cost_metrics || {};
    if (typeof cm.model_calls === "number") aggregateCost.model_calls += cm.model_calls;
    if (typeof cm.role_turns === "number") aggregateCost.role_turns += cm.role_turns;
    if (typeof cm.tool_calls === "number") aggregateCost.tool_calls += cm.tool_calls;
    if (typeof cm.input_tokens === "number") aggregateCost.input_tokens += cm.input_tokens;
    if (typeof cm.output_tokens === "number") aggregateCost.output_tokens += cm.output_tokens;
    if (typeof cm.latency_ms === "number") aggregateCost.latency_ms += cm.latency_ms;
  }

  let reportStatus;
  if (ineligibleTrajectories > 0) {
    reportStatus = "INELIGIBLE";
  } else if (unknownBranchCount > 0) {
    reportStatus = "NEEDS_EXPLORATION";
  } else if (completeSupportCount === totalTrajectories && totalTrajectories > 0) {
    reportStatus = REPLAY_STATUS.EXACT_REPLAY_COMPLETE;
  } else {
    reportStatus = (!Array.isArray(replay) && replay?.status) || "EVALUATED";
  }

  const rootSnapshotId =
    world?.root_snapshot_id ||
    (typeof world?.rootSnapshotId === "string" ? world.rootSnapshotId : null);
  const taskFp =
    (typeof world?.task_fingerprint === "string"
      ? world.task_fingerprint
      : typeof world?.taskFingerprint === "string"
        ? world.taskFingerprint
        : null);

  return {
    candidate_policy_id: candidatePolicyId,
    policy_id: candidatePolicyId,
    world_root_snapshot_id: rootSnapshotId,
    world_task_fingerprint: taskFp,
    replay_status: (!Array.isArray(replay) && replay?.status) || null,
    status: reportStatus,
    total_trajectories: totalTrajectories,
    eligible_trajectories: eligibleTrajectories,
    ineligible_trajectories: ineligibleTrajectories,
    complete_support_count: completeSupportCount,
    unknown_branch_count: unknownBranchCount,
    accepted_count: acceptedCount,
    acceptance_rate: acceptanceRate,
    first_pass_count: firstPassCount,
    first_pass_rate: firstPassRate,
    total_retries: totalRetries,
    aggregate_cost_metrics: aggregateCost,
    evaluated_trajectories: evaluatedTrajectories,
    created_at: new Date().toISOString(),
  };
}
