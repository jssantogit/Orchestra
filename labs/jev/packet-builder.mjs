import {
  DEFAULT_JEV_LIMITS,
  JEV_AUTHORITY,
  JEV_SCHEMAS,
  contentId,
} from "./schemas.mjs";
import { selectRankedReferences } from "./artifact-ranker.mjs";

export function buildCounterfactualPacket({
  mandatoryCore,
  candidates,
  ranking,
  maxAuxItems = DEFAULT_JEV_LIMITS.max_selected_items,
  maxAuxBytes = DEFAULT_JEV_LIMITS.max_selected_bytes,
} = {}) {
  if (!mandatoryCore || typeof mandatoryCore !== "object" || Array.isArray(mandatoryCore)) {
    throw new Error("JEV_MANDATORY_CORE_REQUIRED");
  }
  const selection = selectRankedReferences({
    candidates,
    ranking,
    maxItems: maxAuxItems,
    maxBytes: maxAuxBytes,
  });

  return {
    schema: JEV_SCHEMAS.PACKET,
    packet_id: contentId("jev-packet", {
      mandatory_core: mandatoryCore,
      selected_ids: selection.selected_ids,
    }),
    authority: JEV_AUTHORITY,
    mode: "COUNTERFACTUAL",
    mandatory_core: mandatoryCore,
    auxiliary_refs: selection.selected.map((item) => ({
      id: item.id,
      kind: item.kind,
      relative_path: item.relative_path || null,
      evidence_id: item.evidence_id || null,
      execution_id: item.execution_id || null,
      summary: item.summary,
      bytes: item.bytes || 0,
    })),
    metrics: {
      jev_candidate_bytes: selection.candidate_bytes,
      jev_selected_bytes: selection.selected_bytes,
      potential_context_reduction: selection.candidate_bytes > 0
        ? Number((1 - selection.selected_bytes / selection.candidate_bytes).toFixed(6))
        : 0,
    },
  };
}

export function assertMandatoryCoreIdentity(before, after) {
  return JSON.stringify(before) === JSON.stringify(after?.mandatory_core);
}
