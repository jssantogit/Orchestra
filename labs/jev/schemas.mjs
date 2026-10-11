import { createHash } from "node:crypto";

export const JEV_SCHEMAS = Object.freeze({
  CANDIDATE: "orchestra.jev-candidate.v1",
  CATALOG: "orchestra.jev-catalog.v1",
  PROJECTION: "orchestra.jev-projection.v1",
  RANKING: "orchestra.jev-ranking.v1",
  SHADOW_REPORT: "orchestra.jev-shadow-report.v1",
  SHADOW_LABEL: "orchestra.jev-shadow-label.v1",
  DREAM_ANNOTATION: "orchestra.jev-dream-annotation.v1",
  PACKET: "orchestra.jev-counterfactual-packet.v1",
  EVALUATION: "orchestra.jev-evaluation.v1",
  APPROVAL: "orchestra.jev-retrieval-approval.v1",
});

export const JEV_AUTHORITY = "NONE";

export const JEV_PHASES = Object.freeze({
  CONTRACT: "L0_CONTRACT",
  OFFLINE_LAB: "L1_OFFLINE_LAB",
  REDUNDANCY_SHADOW: "L2_REDUNDANCY_SHADOW",
  DREAM_ANALYSIS: "L3_DREAM_ANALYSIS",
  COUNTERFACTUAL_PACKET: "L4_COUNTERFACTUAL_PACKET",
  LIVE_SHADOW: "L5_LIVE_SHADOW",
  RETRIEVAL_ASSIST: "L6_RETRIEVAL_ASSIST",
  BROADER_RANKING: "L7_BROADER_RANKING",
});

export const DEFAULT_JEV_LIMITS = Object.freeze({
  max_candidates_before_jev: 64,
  max_projection_bytes: 65536,
  max_candidate_summary_chars: 480,
  max_selected_items: 8,
  max_selected_bytes: 16384,
  max_questions_per_request: 128,
  timeout_ms: 5000,
});

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
  ).digest("hex");
}

export function contentId(prefix, value) {
  return `${prefix}-${sha256(value).slice(0, 24)}`;
}

export function byteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

export function normalizeToken(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function validateCandidate(candidate) {
  const issues = [];
  if (candidate?.schema !== JEV_SCHEMAS.CANDIDATE) issues.push("INVALID_SCHEMA");
  if (!candidate?.id || typeof candidate.id !== "string") issues.push("MISSING_ID");
  if (!candidate?.kind || typeof candidate.kind !== "string") issues.push("MISSING_KIND");
  if (candidate?.authority !== JEV_AUTHORITY) issues.push("INVALID_AUTHORITY");
  if (typeof candidate?.summary !== "string") issues.push("MISSING_SUMMARY");
  if (!Number.isInteger(candidate?.bytes) || candidate.bytes < 0) issues.push("INVALID_BYTES");
  return { valid: issues.length === 0, issues };
}

export function validateProjection(projection) {
  const issues = [];
  if (projection?.schema !== JEV_SCHEMAS.PROJECTION) issues.push("INVALID_SCHEMA");
  if (projection?.authority !== JEV_AUTHORITY) issues.push("INVALID_AUTHORITY");
  if (!projection?.goal || typeof projection.goal !== "string") issues.push("MISSING_GOAL");
  if (!Array.isArray(projection?.candidates)) issues.push("MISSING_CANDIDATES");
  for (const candidate of projection?.candidates || []) {
    const allowed = new Set([
      "id", "kind", "summary", "task_id", "mutation_seq", "evidence_id",
      "execution_id", "result", "bytes", "tags", "relative_path", "pinned",
      "freshness", "source_kind",
    ]);
    for (const key of Object.keys(candidate || {})) {
      if (!allowed.has(key)) issues.push(`FORBIDDEN_CANDIDATE_FIELD:${key}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

export function validateRanking(ranking) {
  const issues = [];
  if (ranking?.schema !== JEV_SCHEMAS.RANKING) issues.push("INVALID_SCHEMA");
  if (ranking?.authority !== JEV_AUTHORITY) issues.push("INVALID_AUTHORITY");
  if (!Array.isArray(ranking?.items)) issues.push("MISSING_ITEMS");
  for (const item of ranking?.items || []) {
    for (const field of ["relevance", "future_use", "duplicate"]) {
      if (typeof item?.[field] !== "number" || !Number.isFinite(item[field]) || item[field] < 0 || item[field] > 1) {
        issues.push(`INVALID_${field.toUpperCase()}:${item?.id || "unknown"}`);
      }
    }
  }
  return { valid: issues.length === 0, issues };
}
