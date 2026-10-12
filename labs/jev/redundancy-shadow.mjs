import { JEV_AUTHORITY, JEV_SCHEMAS, contentId } from "./schemas.mjs";
import { projectForJev } from "./outbound-projector.mjs";
import { noul } from "./client.mjs";

export async function scoreRedundancyShadow({
  client,
  goal,
  proposedToolCall,
  recentToolCalls = [],
  task = {},
  live = false,
} = {}) {
  const candidate = {
    schema: JEV_SCHEMAS.CANDIDATE,
    id: contentId("jev-tool-call", {
      tool: proposedToolCall?.tool,
      args: proposedToolCall?.args || {},
    }),
    authority: JEV_AUTHORITY,
    kind: "PROPOSED_TOOL_CALL",
    source_kind: "SHADOW_ONLY",
    summary: `${proposedToolCall?.tool || "unknown"} ${JSON.stringify(proposedToolCall?.args || {}).slice(0, 320)}`,
    bytes: 0,
    tags: ["tool-call", "shadow"],
    pinned: false,
    freshness: "CURRENT",
  };

  const historyCandidates = (recentToolCalls || []).slice(-12).map((call, index) => ({
    schema: JEV_SCHEMAS.CANDIDATE,
    id: contentId("jev-recent-call", { index, tool: call.tool, args: call.args || {}, result: call.result || null }),
    authority: JEV_AUTHORITY,
    kind: "RECENT_TOOL_CALL",
    source_kind: "TOOL_HISTORY",
    summary: `${call.tool || "unknown"} ${JSON.stringify(call.args || {}).slice(0, 220)} => ${String(call.result || "").slice(0, 120)}`,
    bytes: 0,
    tags: ["tool-call", "history"],
    pinned: false,
    freshness: "CURRENT",
  }));

  const projection = projectForJev({
    goal,
    task,
    candidates: [candidate, ...historyCandidates],
    includeRelativePaths: false,
  });
  const questions = {
    adds_new_information: {
      type: "noul",
      instructions: `Probability that proposed tool call candidate ${candidate.id} will add materially new information rather than repeat known information.`,
    },
    likely_redundant: {
      type: "noul",
      instructions: `Probability that proposed tool call candidate ${candidate.id} is redundant with the recent tool-call history.`,
    },
  };
  const response = await client.ask(projection, questions, { live });
  if (response.skipped) {
    return {
      schema: JEV_SCHEMAS.SHADOW_REPORT,
      authority: JEV_AUTHORITY,
      mode: "SHADOW_ONLY",
      skipped: true,
      reason: response.reason,
      blocks_tool: false,
    };
  }
  return {
    schema: JEV_SCHEMAS.SHADOW_REPORT,
    shadow_id: contentId("jev-redundancy", { projection_id: projection.projection_id, call: candidate.id }),
    authority: JEV_AUTHORITY,
    mode: "SHADOW_ONLY",
    blocks_tool: false,
    proposed_tool_call_id: candidate.id,
    p_adds_new_information: noul(response, "adds_new_information"),
    p_redundant: noul(response, "likely_redundant"),
    latency_ms: response.latency_ms || 0,
    usage: response.usage || {},
  };
}
