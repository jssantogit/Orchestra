import { evaluatePolicyCandidate } from "./evaluation.mjs";
import { evaluateHoldoutReplay } from "./replay.mjs";

export function evaluatePromotionCandidate(input = {}) {
  const evaluation = evaluatePolicyCandidate(input);
  return Object.freeze({
    ...evaluation,
    promotable: evaluation.passed === true,
  });
}

export function activatePromotionCandidate({ candidate, cohorts, gate, policyStore } = {}) {
  const evaluation = evaluatePromotionCandidate({ candidate, cohorts, gate });
  if (!evaluation.promotable) return evaluation;

  const replay = evaluateHoldoutReplay({
    candidate,
    promotionEvidence: evaluation.evidence,
    holdout: cohorts?.holdout,
    gate,
  });
  if (!replay.passed) return replay;

  if (!policyStore || typeof policyStore.activate !== "function") {
    return Object.freeze({
      ok: false,
      code: "RSI_POLICY_STORE_REQUIRED",
      evaluation,
      replay,
    });
  }

  const activationResult = policyStore.activate({
    policyId: candidate.policyId,
    revision: candidate.revision,
  });
  if (!activationResult?.ok) {
    return Object.freeze({
      ok: false,
      code: activationResult?.reason ?? "RSI_POLICY_ACTIVATION_FAILED",
      evaluation,
      replay,
    });
  }

  return Object.freeze({
    ok: true,
    code: "RSI_POLICY_ACTIVATED",
    active: activationResult.active,
    activation: activationResult.active?.activation ?? null,
    replayed: activationResult.replayed === true,
    evaluation,
    replay,
  });
}
