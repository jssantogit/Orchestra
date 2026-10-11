import { JEV_AUTHORITY, JEV_SCHEMAS, contentId } from "./schemas.mjs";

function scalarValues(value, out = new Set()) {
  if (value === null || value === undefined) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.add(String(value).toLowerCase());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) scalarValues(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) scalarValues(item, out);
  }
  return out;
}

export function deriveFutureUseLabels({
  candidates,
  futureEvents,
  criticalIds = [],
} = {}) {
  const critical = new Set(criticalIds || []);
  const eventScalars = (futureEvents || []).map((event) => scalarValues(event));
  return (candidates || []).map((candidate) => {
    const needles = [
      candidate.id,
      candidate.evidence_id,
      candidate.execution_id,
      candidate.relative_path,
    ].filter(Boolean).map((value) => String(value).toLowerCase());

    const used = needles.length > 0 && eventScalars.some((values) => needles.some((needle) => values.has(needle)));
    const causallyUseful = used && (futureEvents || []).some((event) => {
      const type = String(event?.type || "").toLowerCase();
      return /evidence|accept|feedback|retry|review/.test(type);
    });
    return {
      id: candidate.id,
      future_used: used,
      causally_useful: causallyUseful,
      critical: critical.has(candidate.id) || candidate.pinned === true,
    };
  });
}

export function evaluateRankingAgainstFutureUse({
  candidates,
  ranking,
  selectedIds = [],
  futureEvents = [],
  criticalIds = [],
  lowThreshold = 0.2,
} = {}) {
  const labels = deriveFutureUseLabels({ candidates, futureEvents, criticalIds });
  const scoreById = new Map((ranking?.items || []).map((item) => [item.id, item]));
  const selected = new Set(selectedIds || []);
  let tp = 0, fp = 0, fn = 0;
  let criticalTotal = 0, criticalSelected = 0;
  let falseLow = 0, futureUsedTotal = 0;

  for (const label of labels) {
    if (label.future_used) {
      futureUsedTotal++;
      if (selected.has(label.id)) tp++;
      else fn++;
      const score = scoreById.get(label.id)?.semantic_score ?? 0;
      if (score <= lowThreshold) falseLow++;
    } else if (selected.has(label.id)) {
      fp++;
    }
    if (label.critical) {
      criticalTotal++;
      if (selected.has(label.id)) criticalSelected++;
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const criticalRecall = criticalTotal > 0 ? criticalSelected / criticalTotal : 1;
  const falseLowRate = futureUsedTotal > 0 ? falseLow / futureUsedTotal : 0;

  return {
    authority: JEV_AUTHORITY,
    oracle_id: contentId("jev-future-use", { labels, selected_ids: [...selected].sort() }),
    labels,
    future_use_precision_at_k: Number(precision.toFixed(6)),
    future_use_recall_at_k: Number(recall.toFixed(6)),
    critical_reference_recall: Number(criticalRecall.toFixed(6)),
    false_low_relevance: Number(falseLowRate.toFixed(6)),
    future_used_total: futureUsedTotal,
    critical_reference_total: criticalTotal,
    future_event_count: futureEvents.length,
  };
}
