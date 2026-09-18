import { DEFAULT_JEV_LIMITS } from "./schemas.mjs";

function tokens(value) {
  return new Set(
    String(value || "").toLowerCase().split(/[^a-z0-9_./-]+/).filter((token) => token.length >= 3),
  );
}

function overlap(a, b) {
  let n = 0;
  for (const token of a) if (b.has(token)) n++;
  return n;
}

const KIND_PRIORITY = Object.freeze({
  EVIDENCE: 50,
  FEEDBACK: 45,
  MUTATION: 35,
  ARTIFACT: 30,
  DREAM_WORLD: 15,
});

export function generateCandidates({
  catalog,
  goal,
  currentTaskId = null,
  pathHints = [],
  symbolHints = [],
  maxCandidates = DEFAULT_JEV_LIMITS.max_candidates_before_jev,
} = {}) {
  const goalTokens = tokens([goal, ...pathHints, ...symbolHints].join(" "));
  const ranked = (catalog?.candidates || []).map((item) => {
    const itemTokens = tokens([
      item.summary,
      item.relative_path,
      ...(item.tags || []),
    ].join(" "));
    let score = KIND_PRIORITY[item.kind] || 0;
    score += overlap(goalTokens, itemTokens) * 10;
    if (currentTaskId && item.task_id === currentTaskId) score += 40;
    if (item.freshness === "CURRENT") score += 15;
    if (item.pinned) score += 1000;
    if (item.result === "FAIL" || item.result === "FALSIFIED") score += 10;
    return { ...item, deterministic_score: score };
  });

  ranked.sort((a, b) =>
    Number(b.pinned) - Number(a.pinned)
    || b.deterministic_score - a.deterministic_score
    || a.id.localeCompare(b.id)
  );

  const pinned = ranked.filter((item) => item.pinned);
  if (pinned.length > maxCandidates) {
    throw new Error("JEV_PINNED_CANDIDATE_OVERFLOW");
  }
  const rest = ranked.filter((item) => !item.pinned);
  const selected = [...pinned, ...rest.slice(0, Math.max(0, maxCandidates - pinned.length))];

  return {
    selected,
    candidate_count_before: ranked.length,
    candidate_count_after: selected.length,
    pinned_count: pinned.length,
    deterministic_only: true,
  };
}
