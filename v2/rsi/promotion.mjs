import { evaluatePolicyCandidate } from "./evaluation.mjs";

export function evaluatePromotionCandidate(input = {}) {
  const evaluation = evaluatePolicyCandidate(input);
  return Object.freeze({
    ...evaluation,
    promotable: evaluation.passed === true,
  });
}
