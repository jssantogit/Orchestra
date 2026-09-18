import { checkRetrievalAssistGate } from "./activation-gate.mjs";
import { buildCounterfactualPacket } from "./packet-builder.mjs";
import { validateProjection, validateRanking } from "./schemas.mjs";

function identityFallback(baselinePacket, mandatoryCore, reasons) {
  return {
    active: false,
    fallback_identity: true,
    reasons,
    packet: baselinePacket ?? mandatoryCore,
  };
}

function validateCurrentRanking({ projection, ranking, candidates }) {
  const reasons = [];
  const projectionValidation = validateProjection(projection);
  if (!projectionValidation.valid) reasons.push("CURRENT_PROJECTION_INVALID");

  const rankingValidation = validateRanking(ranking);
  if (!rankingValidation.valid) reasons.push("CURRENT_RANKING_INVALID");
  if (ranking?.skipped === true) reasons.push("CURRENT_RANKING_SKIPPED");
  if (!ranking?.projection_id || ranking.projection_id !== projection?.projection_id) {
    reasons.push("CURRENT_RANKING_PROJECTION_MISMATCH");
  }

  const candidateIds = [...new Set((candidates || []).map((item) => item.id))].sort();
  const projectionIds = [...new Set((projection?.candidates || []).map((item) => item.id))].sort();
  const rankingIds = [...new Set((ranking?.items || []).map((item) => item.id))].sort();
  if (JSON.stringify(candidateIds) !== JSON.stringify(projectionIds)) {
    reasons.push("CURRENT_CANDIDATE_PROJECTION_MISMATCH");
  }
  if (JSON.stringify(candidateIds) !== JSON.stringify(rankingIds)) {
    reasons.push("CURRENT_RANKING_COVERAGE_MISMATCH");
  }
  return reasons;
}

export function buildRetrievalAssistedPacket({
  projectRoot,
  baselinePacket = null,
  mandatoryCore,
  projection,
  candidates,
  ranking,
  env = process.env,
  limits = {},
} = {}) {
  const gate = checkRetrievalAssistGate({ projectRoot, env });
  if (!gate.allowed) {
    return identityFallback(baselinePacket, mandatoryCore, gate.reasons);
  }

  const currentReasons = validateCurrentRanking({ projection, ranking, candidates });
  if (currentReasons.length > 0) {
    return identityFallback(baselinePacket, mandatoryCore, currentReasons);
  }

  const packet = buildCounterfactualPacket({
    mandatoryCore,
    candidates,
    ranking,
    maxAuxItems: limits.maxAuxItems,
    maxAuxBytes: limits.maxAuxBytes,
  });
  return {
    active: true,
    fallback_identity: false,
    reasons: [],
    packet,
  };
}
