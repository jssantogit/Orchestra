import { JEV_AUTHORITY, JEV_SCHEMAS, contentId } from "./schemas.mjs";

export const DEFAULT_PROMOTION_GATES = Object.freeze({
  min_samples: 30,
  min_task_categories: 5,
  min_future_use_recall_at_k: 0.95,
  min_critical_reference_recall: 1.0,
  max_false_low_relevance: 0.02,
  max_tool_reexecution_delta: 0,
  min_acceptance_delta: 0,
  min_context_reduction: 0.10,
});

function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function aggregateJevRuns(runs = []) {
  const samples = runs.length;
  const categories = new Set(runs.map((run) => run.task_category).filter(Boolean));
  const weighted = (field) => samples > 0
    ? runs.reduce((sum, run) => sum + finite(run[field]), 0) / samples
    : 0;
  const sum = (field) => runs.reduce((total, run) => total + finite(run[field]), 0);

  return {
    samples,
    task_categories: [...categories].sort(),
    task_category_count: categories.size,
    jev_calls: sum("jev_calls"),
    jev_latency_ms: sum("jev_latency_ms"),
    jev_input_tokens: sum("jev_input_tokens"),
    jev_candidates: sum("jev_candidates"),
    jev_ranked_items: sum("jev_ranked_items"),
    jev_candidate_bytes: sum("jev_candidate_bytes"),
    jev_selected_bytes: sum("jev_selected_bytes"),
    potential_context_reduction: weighted("potential_context_reduction"),
    future_use_recall_at_k: weighted("future_use_recall_at_k"),
    future_use_precision_at_k: weighted("future_use_precision_at_k"),
    critical_reference_recall: weighted("critical_reference_recall"),
    false_low_relevance: weighted("false_low_relevance"),
    redundant_tool_candidates: sum("redundant_tool_candidates"),
    rehydration_count: sum("rehydration_count"),
    tool_reexecution_delta: weighted("tool_reexecution_delta"),
    acceptance_delta: weighted("acceptance_delta"),
    fallback_identity_failures: sum("fallback_identity_failures"),
  };
}

export function evaluateForRetrievalAssist(runs = [], gates = DEFAULT_PROMOTION_GATES) {
  const metrics = aggregateJevRuns(runs);
  const violations = [];
  if (metrics.samples < gates.min_samples) violations.push("INSUFFICIENT_SAMPLES");
  if (metrics.task_category_count < gates.min_task_categories) violations.push("INSUFFICIENT_TASK_COVERAGE");
  if (metrics.future_use_recall_at_k < gates.min_future_use_recall_at_k) violations.push("FUTURE_USE_RECALL");
  if (metrics.critical_reference_recall < gates.min_critical_reference_recall) violations.push("CRITICAL_REFERENCE_RECALL");
  if (metrics.false_low_relevance > gates.max_false_low_relevance) violations.push("FALSE_LOW_RELEVANCE");
  if (metrics.tool_reexecution_delta > gates.max_tool_reexecution_delta) violations.push("TOOL_REEXECUTION_REGRESSION");
  if (metrics.acceptance_delta < gates.min_acceptance_delta) violations.push("ACCEPTANCE_REGRESSION");
  if (metrics.potential_context_reduction < gates.min_context_reduction) violations.push("CONTEXT_REDUCTION_INSUFFICIENT");
  if (metrics.fallback_identity_failures > 0) violations.push("FALLBACK_NOT_IDENTITY");

  const report = {
    schema: JEV_SCHEMAS.EVALUATION,
    authority: JEV_AUTHORITY,
    gates,
    metrics,
    eligible_for_retrieval_assist: violations.length === 0,
    violations,
  };
  report.report_id = contentId("jev-evaluation", report);
  return report;
}
