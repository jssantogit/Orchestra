import { checkRetrievalAssistGate } from "./activation-gate.mjs";
import { buildCounterfactualPacket } from "./packet-builder.mjs";

export function buildRetrievalAssistedPacket({
  projectRoot,
  report,
  mandatoryCore,
  candidates,
  ranking,
  env = process.env,
  limits = {},
} = {}) {
  const gate = checkRetrievalAssistGate({ projectRoot, report, env });
  if (!gate.allowed) {
    return {
      active: false,
      fallback_identity: true,
      reasons: gate.reasons,
      packet: mandatoryCore,
    };
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
