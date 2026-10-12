export const EXPLORATION_BUDGET = Object.freeze({
  max_sibling_branches: 1,
  max_model_calls: 2,
  timeout_ms: 300000,
});

export const FULL_EXPLORATION_LIMITS = Object.freeze({
  max_branches: 3,
  max_parallel: 2,
  max_total_model_calls: 6,
  timeout_ms: 900000,
});

export function fullExplorationLimitsMatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return value.max_branches === FULL_EXPLORATION_LIMITS.max_branches
    && value.max_parallel === FULL_EXPLORATION_LIMITS.max_parallel
    && value.max_total_model_calls === FULL_EXPLORATION_LIMITS.max_total_model_calls
    && value.timeout_ms === FULL_EXPLORATION_LIMITS.timeout_ms;
}
