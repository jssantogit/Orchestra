import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { buildCatalog } from "./catalog-builder.mjs";
import { generateCandidates } from "./candidate-generator.mjs";
import { projectForJev } from "./outbound-projector.mjs";
import { rankCandidates, selectRankedReferences } from "./artifact-ranker.mjs";
import { evaluateRankingAgainstFutureUse } from "./future-use-oracle.mjs";
import { buildCounterfactualPacket } from "./packet-builder.mjs";
import { JEV_AUTHORITY, JEV_SCHEMAS } from "./schemas.mjs";
import { assertLiveEgressAllowed } from "./egress-policy.mjs";

export const SHADOW_TELEMETRY_PATH = ".agents/telemetry/jev-shadow.jsonl";
export const SHADOW_STATE_ROOT = ".agents/semantic/jev-shadow";

function appendEvent(projectRoot, event) {
  const path = resolve(projectRoot, SHADOW_TELEMETRY_PATH);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
  return path;
}

function statePath(projectRoot, shadowId) {
  return resolve(projectRoot, SHADOW_STATE_ROOT, `${shadowId}.json`);
}

function writeShadowState(projectRoot, state) {
  const path = statePath(projectRoot, state.shadow_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx" });
  return path;
}

function readShadowState(projectRoot, shadowId) {
  try { return JSON.parse(readFileSync(statePath(projectRoot, shadowId), "utf8")); }
  catch { return null; }
}

export function readShadowTelemetry(projectRoot) {
  const path = resolve(projectRoot, SHADOW_TELEMETRY_PATH);
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(JSON.parse);
  } catch {
    return [];
  }
}

export function createShadowLabel({
  shadowId,
  candidates,
  ranking,
  selectedIds,
  futureEvents,
  criticalIds = [],
  labelSource = "EXPLICIT_FUTURE_EVENTS",
  comparativeOutcome = null,
} = {}) {
  if (!shadowId) throw new Error("JEV_SHADOW_ID_REQUIRED");
  if (!Array.isArray(futureEvents) || futureEvents.length === 0) {
    throw new Error("JEV_FUTURE_EVENTS_REQUIRED");
  }
  const oracle = evaluateRankingAgainstFutureUse({
    candidates,
    ranking,
    selectedIds,
    futureEvents,
    criticalIds,
  });
  return {
    schema: JEV_SCHEMAS.SHADOW_LABEL,
    shadow_id: shadowId,
    authority: JEV_AUTHORITY,
    label_source: labelSource,
    timestamp: new Date().toISOString(),
    future_event_count: oracle.future_event_count,
    future_used_total: oracle.future_used_total,
    critical_reference_total: oracle.critical_reference_total,
    future_use_recall_at_k: oracle.future_use_recall_at_k,
    future_use_precision_at_k: oracle.future_use_precision_at_k,
    critical_reference_recall: oracle.critical_reference_recall,
    false_low_relevance: oracle.false_low_relevance,
    false_prune_risk: oracle.false_low_relevance,
    comparative_outcome_verified: comparativeOutcome?.verified === true,
    comparison_source: comparativeOutcome?.verified === true
      ? String(comparativeOutcome.source || "UNKNOWN_COMPARISON")
      : null,
    tool_reexecution_delta: comparativeOutcome?.verified === true
      && typeof comparativeOutcome.tool_reexecution_delta === "number"
        ? comparativeOutcome.tool_reexecution_delta
        : null,
    acceptance_delta: comparativeOutcome?.verified === true
      && typeof comparativeOutcome.acceptance_delta === "number"
        ? comparativeOutcome.acceptance_delta
        : null,
  };
}

export function labelShadowRun({
  projectRoot,
  shadowId,
  futureEvents,
  criticalIds = [],
} = {}) {
  const prior = readShadowTelemetry(projectRoot);
  if (prior.some((event) => event?.schema === JEV_SCHEMAS.SHADOW_LABEL && event?.shadow_id === shadowId)) {
    throw new Error("JEV_SHADOW_ALREADY_LABELED");
  }
  const state = readShadowState(projectRoot, shadowId);
  if (!state) throw new Error("JEV_SHADOW_STATE_NOT_FOUND");
  const label = createShadowLabel({
    shadowId,
    candidates: state.candidates,
    ranking: state.ranking,
    selectedIds: state.selected_ids,
    futureEvents,
    criticalIds,
    labelSource: "EXPLICIT_FUTURE_EVENTS",
  });
  appendEvent(projectRoot, label);
  return label;
}

function readRuntimeTelemetryAfter(projectRoot, timestamp) {
  const path = resolve(projectRoot, ".agents/telemetry/events.jsonl");
  if (!existsSync(path)) return { events: [], malformed: 0 };
  const threshold = Date.parse(timestamp || "");
  const events = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n").map((item) => item.trim()).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      const eventTime = Date.parse(event.timestamp || event.created_at || event.observedAt || "");
      if (Number.isFinite(threshold) && Number.isFinite(eventTime) && eventTime <= threshold) continue;
      events.push(event);
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

export function labelShadowRunFromProjectTelemetry({
  projectRoot,
  shadowId,
} = {}) {
  const prior = readShadowTelemetry(projectRoot);
  if (prior.some((event) => event?.schema === JEV_SCHEMAS.SHADOW_LABEL && event?.shadow_id === shadowId)) {
    throw new Error("JEV_SHADOW_ALREADY_LABELED");
  }
  const report = prior.find((event) => (
    event?.schema === JEV_SCHEMAS.SHADOW_REPORT
    && event?.shadow_id === shadowId
    && event?.authority === JEV_AUTHORITY
  ));
  if (!report) throw new Error("JEV_SHADOW_REPORT_NOT_FOUND");

  const state = readShadowState(projectRoot, shadowId);
  if (!state) throw new Error("JEV_SHADOW_STATE_NOT_FOUND");
  const runtime = readRuntimeTelemetryAfter(projectRoot, report.timestamp);
  if (runtime.malformed > 0) throw new Error("JEV_RUNTIME_TELEMETRY_MALFORMED");
  if (runtime.events.length === 0) throw new Error("JEV_NO_FUTURE_RUNTIME_EVENTS");

  const criticalIds = (state.candidates || [])
    .filter((candidate) => candidate.pinned === true)
    .map((candidate) => candidate.id);

  const label = createShadowLabel({
    shadowId,
    candidates: state.candidates,
    ranking: state.ranking,
    selectedIds: state.selected_ids,
    futureEvents: runtime.events,
    criticalIds,
    labelSource: "PROJECT_RUNTIME_TELEMETRY",
  });
  appendEvent(projectRoot, label);
  return label;
}

export function readLabeledShadowRuns(projectRoot) {
  const events = readShadowTelemetry(projectRoot);
  const reports = new Map();
  const labels = new Map();
  for (const event of events) {
    if (
      event?.schema === JEV_SCHEMAS.SHADOW_REPORT
      && event?.authority === JEV_AUTHORITY
      && event?.shadow_id
    ) {
      reports.set(event.shadow_id, event);
    }
    if (
      event?.schema === JEV_SCHEMAS.SHADOW_LABEL
      && event?.authority === JEV_AUTHORITY
      && event?.label_source === "PROJECT_RUNTIME_TELEMETRY"
      && event?.shadow_id
    ) {
      labels.set(event.shadow_id, event);
    }
  }
  const runs = [];
  for (const [shadowId, report] of reports) {
    const label = labels.get(shadowId);
    if (!label) continue;
    runs.push({
      ...report,
      ...label,
      schema: JEV_SCHEMAS.SHADOW_REPORT,
      shadow_id: shadowId,
      labeled: true,
    });
  }
  return runs.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
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
  env = process.env,
} = {}) {
  const egress = assertLiveEgressAllowed({ projectRoot, live, env });
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

  const packet = buildCounterfactualPacket({
    mandatoryCore,
    candidates: generated.selected,
    ranking,
  });

  const candidateBytes = selected.candidate_bytes || 0;
  const selectedBytes = selected.selected_bytes || 0;
  const shadowId = "jev-shadow-" + randomUUID();
  const event = {
    schema: JEV_SCHEMAS.SHADOW_REPORT,
    shadow_id: shadowId,
    authority: JEV_AUTHORITY,
    mode: live ? "LIVE_SHADOW" : "OFFLINE_SHADOW",
    egress_mode: egress.mode,
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
    fallback_identity_failures: 0,
    tool_reexecution_delta: 0,
    acceptance_delta: 0,
    elapsed_ms: Date.now() - started,
    selected_ids: selected.selected_ids,
    ranking_id: ranking.ranking_id,
    projection_id: projection.projection_id,
    counterfactual_packet_id: packet.packet_id,
    labeled: false,
  };
  const telemetryPath = appendEvent(projectRoot, event);
  const shadowStatePath = writeShadowState(projectRoot, {
    schema: "orchestra.jev-shadow-state.v1",
    shadow_id: shadowId,
    authority: JEV_AUTHORITY,
    projection,
    candidates: generated.selected,
    ranking,
    selected_ids: selected.selected_ids,
    created_at: event.timestamp,
  });

  let label = null;
  if (Array.isArray(futureEvents) && futureEvents.length > 0) {
    label = createShadowLabel({
      shadowId,
      candidates: generated.selected,
      ranking,
      selectedIds: selected.selected_ids,
      futureEvents,
      criticalIds,
      labelSource: "OFFLINE_FUTURE_EVENTS",
    });
    appendEvent(projectRoot, label);
  }

  return {
    event,
    label,
    catalog,
    candidates: generated,
    projection,
    ranking,
    counterfactualPacket: packet,
    telemetryPath,
    shadowStatePath,
  };
}
