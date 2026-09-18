import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildCatalog } from "./catalog-builder.mjs";
import { generateCandidates } from "./candidate-generator.mjs";
import { projectForJev } from "./outbound-projector.mjs";
import { rankCandidates, selectRankedReferences } from "./artifact-ranker.mjs";
import { evaluateRankingAgainstFutureUse } from "./future-use-oracle.mjs";
import { buildCounterfactualPacket } from "./packet-builder.mjs";
import { JEV_AUTHORITY, JEV_SCHEMAS, contentId } from "./schemas.mjs";

export const SHADOW_TELEMETRY_PATH = ".agents/telemetry/jev-shadow.jsonl";

function appendEvent(projectRoot, event) {
  const path = resolve(projectRoot, SHADOW_TELEMETRY_PATH);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
  return path;
}

export async function runArtifactRankingShadow({
  projectRoot,
  client,
  goal,
  task = {},
  live = false,
  futureEvents = [],
  criticalIds = [],
  mandatoryCore = {},
  pathHints = [],
  symbolHints = [],
} = {}) {
  const started = Date.now();
  const catalog = buildCatalog(projectRoot);
  const generated = generateCandidates({
    catalog,
    goal,
    currentTaskId: task.task_id || catalog.task_id || null,
    pathHints,
    symbolHints,
  });
  const projection = projectForJev({
    goal,
    task,
    candidates: generated.selected,
  });
  const ranking = await rankCandidates({ client, projection, live });

  const selected = ranking.skipped
    ? {
        selected: generated.selected.filter((item) => item.pinned),
        selected_ids: generated.selected.filter((item) => item.pinned).map((item) => item.id),
        selected_bytes: generated.selected.filter((item) => item.pinned).reduce((sum, item) => sum + (item.bytes || 0), 0),
        candidate_bytes: generated.selected.reduce((sum, item) => sum + (item.bytes || 0), 0),
      }
    : selectRankedReferences({ candidates: generated.selected, ranking });

  const oracle = evaluateRankingAgainstFutureUse({
    candidates: generated.selected,
    ranking,
    selectedIds: selected.selected_ids,
    futureEvents,
    criticalIds,
  });

  const packet = buildCounterfactualPacket({
    mandatoryCore,
    candidates: generated.selected,
    ranking,
  });

  const candidateBytes = selected.candidate_bytes || 0;
  const selectedBytes = selected.selected_bytes || 0;
  const event = {
    schema: JEV_SCHEMAS.SHADOW_REPORT,
    shadow_id: contentId("jev-shadow", {
      projection_id: projection.projection_id,
      ranking_id: ranking.ranking_id,
      task_id: task.task_id || null,
    }),
    authority: JEV_AUTHORITY,
    mode: live ? "LIVE_SHADOW" : "OFFLINE_SHADOW",
    blocks_tool: false,
    changes_packet: false,
    task_id: task.task_id || null,
    task_category: task.task_category || task.task_action || null,
    timestamp: new Date().toISOString(),
    jev_calls: ranking.skipped ? 0 : (ranking.request_count || 1),
    jev_latency_ms: ranking.latency_ms || 0,
    jev_input_tokens: ranking.usage?.input_tokens || 0,
    jev_candidates: generated.candidate_count_after,
    jev_ranked_items: ranking.items?.length || 0,
    jev_candidate_bytes: candidateBytes,
    jev_selected_bytes: selectedBytes,
    potential_context_reduction: candidateBytes > 0
      ? Number((1 - selectedBytes / candidateBytes).toFixed(6))
      : 0,
    redundant_tool_candidates: 0,
    rehydration_count: 0,
    false_prune_risk: oracle.false_low_relevance,
    future_use_recall_at_k: oracle.future_use_recall_at_k,
    future_use_precision_at_k: oracle.future_use_precision_at_k,
    critical_reference_recall: oracle.critical_reference_recall,
    false_low_relevance: oracle.false_low_relevance,
    fallback_identity_failures: 0,
    tool_reexecution_delta: 0,
    acceptance_delta: 0,
    elapsed_ms: Date.now() - started,
    selected_ids: selected.selected_ids,
    ranking_id: ranking.ranking_id,
    projection_id: projection.projection_id,
    counterfactual_packet_id: packet.packet_id,
  };
  const telemetryPath = appendEvent(projectRoot, event);
  return {
    event,
    catalog,
    candidates: generated,
    projection,
    ranking,
    oracle,
    counterfactualPacket: packet,
    telemetryPath,
  };
}

export function readShadowTelemetry(projectRoot) {
  const path = resolve(projectRoot, SHADOW_TELEMETRY_PATH);
  try {
    return readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}
