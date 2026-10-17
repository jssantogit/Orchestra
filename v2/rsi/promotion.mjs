import { evaluatePolicyCandidate } from "./evaluation.mjs";
import { evaluateCounterexampleDemotion, evaluateHoldoutReplay } from "./replay.mjs";

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

export function demotePromotionCandidate({ candidate, counterexample, policyStore } = {}) {
  const assessment = evaluateCounterexampleDemotion({ candidate, counterexample });
  if (!assessment.ok || !assessment.qualifies) {
    return Object.freeze({ ...assessment, demoted: false });
  }
  if (!policyStore || typeof policyStore.rollback !== "function") {
    return Object.freeze({
      ok: false,
      code: "RSI_POLICY_STORE_REQUIRED",
      assessment,
    });
  }

  const rollback = policyStore.rollback({
    policyId: candidate.policyId,
    revision: candidate.revision,
  });
  if (!rollback?.ok) {
    return Object.freeze({
      ok: false,
      code: rollback?.reason ?? "RSI_POLICY_DEMOTION_FAILED",
      assessment,
      rollback,
    });
  }

  return Object.freeze({
    ok: true,
    code: "RSI_POLICY_DEMOTED",
    demoted: true,
    active: rollback.active ?? null,
    replayed: rollback.replayed === true,
    demotion: Object.freeze({
      lifecycle: "PENDING_REVIEW",
      policy: Object.freeze({
        policyId: candidate.policyId,
        revision: candidate.revision,
      }),
      counterexampleExperienceId: counterexample.experienceId,
    }),
    assessment,
    rollback,
  });
}
