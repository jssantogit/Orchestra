import {
  DEFAULT_JEV_LIMITS,
  JEV_AUTHORITY,
  JEV_SCHEMAS,
  contentId,
  validateRanking,
} from "./schemas.mjs";
import { noul } from "./client.mjs";

export function buildRankingQuestions(projection) {
  const questions = {};
  for (const candidate of projection.candidates || []) {
    questions[`useful__${candidate.id}`] = {
      type: "noul",
      instructions: `Probability that candidate ${candidate.id} will be useful in the next worker/reviewer/orchestrator auxiliary context for the stated goal.`,
      criteria: {
        true: "Likely to materially help the next step.",
        false: "Unlikely to materially help the next step.",
      },
    };
    questions[`future__${candidate.id}`] = {
      type: "noul",
      instructions: `Probability that candidate ${candidate.id} will be factually referenced, retrieved, or needed later in this task.`,
    };
    questions[`duplicate__${candidate.id}`] = {
      type: "noul",
      instructions: `Probability that candidate ${candidate.id} is redundant with information already represented by stronger candidates in this projection.`,
    };
  }
  return questions;
}

export async function rankCandidates({
  client,
  projection,
  live = false,
} = {}) {
  if (!client?.ask) throw new Error("JEV_CLIENT_REQUIRED");
  const questions = buildRankingQuestions(projection);
  if (Object.keys(questions).length > DEFAULT_JEV_LIMITS.max_questions_per_request) {
    throw new Error("JEV_TOO_MANY_QUESTIONS");
  }
  const started = Date.now();
  const response = await client.ask(projection, questions, { live });
  if (response.skipped) {
    return {
      schema: JEV_SCHEMAS.RANKING,
      ranking_id: contentId("jev-ranking", { projection_id: projection.projection_id, skipped: true }),
      authority: JEV_AUTHORITY,
      projection_id: projection.projection_id,
      model: response.model || null,
      skipped: true,
      reason: response.reason || "JEV_SKIPPED",
      latency_ms: 0,
      usage: response.usage || {},
      items: [],
    };
  }

  const items = (projection.candidates || []).map((candidate) => {
    const relevance = noul(response, `useful__${candidate.id}`);
    const futureUse = noul(response, `future__${candidate.id}`);
    const duplicate = noul(response, `duplicate__${candidate.id}`);
    const score = Math.max(0, Math.min(1, (0.55 * relevance) + (0.35 * futureUse) + (0.10 * (1 - duplicate))));
    return {
      id: candidate.id,
      relevance,
      future_use: futureUse,
      duplicate,
      semantic_score: Number(score.toFixed(6)),
      pinned: candidate.pinned === true,
      bytes: candidate.bytes || 0,
    };
  }).sort((a, b) =>
    Number(b.pinned) - Number(a.pinned)
    || b.semantic_score - a.semantic_score
    || a.id.localeCompare(b.id)
  );

  const ranking = {
    schema: JEV_SCHEMAS.RANKING,
    ranking_id: contentId("jev-ranking", {
      projection_id: projection.projection_id,
      model: response.model || null,
      items,
    }),
    authority: JEV_AUTHORITY,
    projection_id: projection.projection_id,
    model: response.model || null,
    skipped: false,
    latency_ms: response.latency_ms ?? (Date.now() - started),
    usage: response.usage || {},
    items,
  };
  const validation = validateRanking(ranking);
  if (!validation.valid) throw new Error(`JEV_INVALID_RANKING:${validation.issues.join(",")}`);
  return ranking;
}

export function selectRankedReferences({
  candidates,
  ranking,
  maxItems = DEFAULT_JEV_LIMITS.max_selected_items,
  maxBytes = DEFAULT_JEV_LIMITS.max_selected_bytes,
} = {}) {
  const byId = new Map((candidates || []).map((item) => [item.id, item]));
  const ranked = (ranking?.items || []).map((item) => ({
    ...item,
    candidate: byId.get(item.id),
  })).filter((item) => item.candidate);

  const selected = [];
  let selectedBytes = 0;

  for (const candidate of candidates || []) {
    if (!candidate.pinned) continue;
    selected.push(candidate);
    selectedBytes += candidate.bytes || 0;
  }

  for (const item of ranked) {
    if (item.candidate.pinned || selected.some((candidate) => candidate.id === item.id)) continue;
    if (selected.length >= maxItems) break;
    const bytes = item.candidate.bytes || 0;
    if (selectedBytes + bytes > maxBytes && selected.length > 0) continue;
    selected.push(item.candidate);
    selectedBytes += bytes;
  }

  return {
    selected,
    selected_ids: selected.map((item) => item.id),
    selected_bytes: selectedBytes,
    candidate_bytes: (candidates || []).reduce((sum, item) => sum + (item.bytes || 0), 0),
  };
}
