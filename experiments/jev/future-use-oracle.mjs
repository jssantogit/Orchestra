import { JEV_AUTHORITY, JEV_SCHEMAS, contentId } from "./schemas.mjs";

function eventText(event) {
  try { return JSON.stringify(event).toLowerCase(); } catch { return ""; }
}

export function deriveFutureUseLabels({
  candidates,
  futureEvents,
  criticalIds = [],
} = {}) {
  const critical = new Set(criticalIds || []);
  const eventsText = (futureEvents || []).map(eventText);
  return (candidates || []).map((candidate) => {
    const needles = [
      candidate.id,
      candidate.evidence_id,
      candidate.execution_id,
      candidate.relative_path,
    ].filter(Boolean).map((value) => String(value).toLowerCase());

    const used = needles.length > 0 && eventsText.some((text) => needles.some((needle) => text.includes(needle)));
    const causallyUseful = used && eventsText.some((text) => (
      text.includes("evidence")
      || text.includes("accept")
      || text.includes("feedback")
      || text.includes("retry")
      || text.includes("review")
    ));
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
  };
}
