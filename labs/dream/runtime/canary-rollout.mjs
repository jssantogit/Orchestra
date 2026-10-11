export const CANARY_ROLLOUT_SCHEMA = "orchestra.canary-rollout.v1";

export const CANARY_ROLLOUT_STAGES = Object.freeze([
  Object.freeze({
    index: 0,
    traffic_percent: 5,
    minimum_completed_outcomes: 1,
    name: "INITIAL_5",
  }),
  Object.freeze({
    index: 1,
    traffic_percent: 20,
    minimum_completed_outcomes: 3,
    name: "EXPANDED_20",
  }),
  Object.freeze({
    index: 2,
    traffic_percent: 50,
    minimum_completed_outcomes: 5,
    name: "EXPANDED_50",
  }),
  Object.freeze({
    index: 3,
    traffic_percent: 100,
    minimum_completed_outcomes: 10,
    name: "FULL_100",
  }),
]);

export function getCanaryRolloutStage(index) {
  if (!Number.isInteger(index)) return null;
  return CANARY_ROLLOUT_STAGES[index] || null;
}

export function getCanaryRolloutStageByTraffic(trafficPercent) {
  const traffic = Number(trafficPercent);
  return CANARY_ROLLOUT_STAGES.find((stage) => stage.traffic_percent === traffic) || null;
}

export function currentCanaryRolloutStage(config = {}) {
  if (Number.isInteger(config.rollout_stage_index)) {
    const stage = getCanaryRolloutStage(config.rollout_stage_index);
    if (!stage || stage.traffic_percent !== Number(config.traffic_percent)) return null;
    return stage;
  }

  // Backward-compatible Milestone H config: fixed 5% with no rollout fields.
  if (Number(config.traffic_percent) === CANARY_ROLLOUT_STAGES[0].traffic_percent) {
    return CANARY_ROLLOUT_STAGES[0];
  }
  return null;
}

export function nextCanaryRolloutStage(config = {}) {
  const current = currentCanaryRolloutStage(config);
  if (!current) return null;
  return getCanaryRolloutStage(current.index + 1);
}

export function isFinalCanaryRolloutStage(config = {}) {
  const current = currentCanaryRolloutStage(config);
  return Boolean(
    current
    && current.index === CANARY_ROLLOUT_STAGES.length - 1
  );
}

export function canAdvanceCanaryRollout({
  config = {},
  executedDecisions = 0,
  completedOutcomes = 0,
  rollbackCount = 0,
} = {}) {
  const stage = currentCanaryRolloutStage(config);
  if (!stage) {
    return { ready: false, reason: "CANARY_ROLLOUT_STAGE_INVALID", stage: null, next: null };
  }
  const next = nextCanaryRolloutStage(config);
  if (!next) {
    return { ready: false, reason: "CANARY_ROLLOUT_FINAL_STAGE", stage, next: null };
  }
  if (Number(rollbackCount || 0) > 0) {
    return { ready: false, reason: "CANARY_ROLLOUT_HAS_ROLLBACK", stage, next };
  }
  if (Number(executedDecisions || 0) <= 0) {
    return { ready: false, reason: "CANARY_ROLLOUT_NO_LIVE_DECISIONS", stage, next };
  }
  if (Number(completedOutcomes || 0) !== Number(executedDecisions || 0)) {
    return { ready: false, reason: "CANARY_ROLLOUT_OUTCOMES_INCOMPLETE", stage, next };
  }
  if (Number(completedOutcomes || 0) < stage.minimum_completed_outcomes) {
    return {
      ready: false,
      reason: "CANARY_ROLLOUT_MINIMUM_OUTCOMES_NOT_MET",
      stage,
      next,
      required: stage.minimum_completed_outcomes,
      observed: Number(completedOutcomes || 0),
    };
  }
  return { ready: true, reason: null, stage, next };
}

export function canPromoteFinalCanaryStage({
  config = {},
  executedDecisions = 0,
  completedOutcomes = 0,
  rollbackCount = 0,
} = {}) {
  const stage = currentCanaryRolloutStage(config);
  if (!stage) {
    return { ready: false, reason: "CANARY_ROLLOUT_STAGE_INVALID", stage: null };
  }
  if (!isFinalCanaryRolloutStage(config)) {
    return { ready: false, reason: "CANARY_ROLLOUT_NOT_FINAL_STAGE", stage };
  }
  if (Number(rollbackCount || 0) > 0) {
    return { ready: false, reason: "CANARY_ROLLOUT_HAS_ROLLBACK", stage };
  }
  if (Number(executedDecisions || 0) <= 0) {
    return { ready: false, reason: "CANARY_ROLLOUT_NO_LIVE_DECISIONS", stage };
  }
  if (Number(completedOutcomes || 0) !== Number(executedDecisions || 0)) {
    return { ready: false, reason: "CANARY_ROLLOUT_OUTCOMES_INCOMPLETE", stage };
  }
  if (Number(completedOutcomes || 0) < stage.minimum_completed_outcomes) {
    return {
      ready: false,
      reason: "CANARY_ROLLOUT_MINIMUM_OUTCOMES_NOT_MET",
      stage,
      required: stage.minimum_completed_outcomes,
      observed: Number(completedOutcomes || 0),
    };
  }
  return { ready: true, reason: null, stage };
}

export function rolloutGeneration(config = {}) {
  return Number.isInteger(config.rollout_generation)
    ? config.rollout_generation
    : Number.isInteger(config.rollout_stage_index)
      ? config.rollout_stage_index
      : 0;
}
