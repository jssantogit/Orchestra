import {
  DEFAULT_JEV_LIMITS,
  JEV_AUTHORITY,
  JEV_SCHEMAS,
  byteLength,
  contentId,
  validateCandidate,
  validateProjection,
} from "./schemas.mjs";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',]{8,}/gi,
];

const FORBIDDEN_SOURCE_FIELDS = new Set([
  "raw", "raw_content", "rawContent", "stdout", "stderr", "body", "content",
  "transcript", "messages", "prompt", "reasoning", "thinking", "secret",
  "credentials", "env", "environment",
]);

export function redactSecrets(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text;
}

function safeSummary(value, maxChars) {
  const compact = redactSecrets(value).replace(/\s+/g, " ").trim();
  return compact.length <= maxChars ? compact : compact.slice(0, maxChars) + "…";
}

function relativeSafePath(value) {
  const path = String(value || "").replace(/\\/g, "/").trim();
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("../")) return null;
  return path;
}

export function assertNoRawFields(candidate) {
  for (const key of Object.keys(candidate || {})) {
    if (FORBIDDEN_SOURCE_FIELDS.has(key)) throw new Error(`JEV_EGRESS_FORBIDDEN_FIELD:${key}`);
  }
}

export function projectForJev({
  goal,
  candidates,
  task = {},
  limits = DEFAULT_JEV_LIMITS,
  includeRelativePaths = true,
} = {}) {
  if (!goal || typeof goal !== "string") throw new Error("JEV_PROJECTION_GOAL_REQUIRED");
  if (!Array.isArray(candidates)) throw new Error("JEV_PROJECTION_CANDIDATES_REQUIRED");

  const projected = [];
  for (const candidate of candidates.slice(0, limits.max_candidates_before_jev)) {
    const validation = validateCandidate(candidate);
    if (!validation.valid) throw new Error(`JEV_INVALID_CANDIDATE:${validation.issues.join(",")}`);
    assertNoRawFields(candidate);

    const item = {
      id: candidate.id,
      kind: candidate.kind,
      source_kind: candidate.source_kind || null,
      summary: safeSummary(candidate.summary, limits.max_candidate_summary_chars),
      task_id: candidate.task_id || null,
      mutation_seq: Number.isInteger(candidate.mutation_seq) ? candidate.mutation_seq : null,
      evidence_id: candidate.evidence_id || null,
      execution_id: candidate.execution_id || null,
      result: candidate.result || null,
      bytes: Number.isInteger(candidate.bytes) ? candidate.bytes : 0,
      tags: Array.isArray(candidate.tags) ? candidate.tags.slice(0, 12).map((tag) => safeSummary(tag, 80)) : [],
      pinned: candidate.pinned === true,
      freshness: candidate.freshness || null,
    };
    const path = includeRelativePaths ? relativeSafePath(candidate.relative_path) : null;
    if (path) item.relative_path = path;
    projected.push(Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null)));
  }

  const projection = {
    schema: JEV_SCHEMAS.PROJECTION,
    projection_id: contentId("jev-projection", {
      goal,
      task_id: task.task_id || null,
      candidate_ids: projected.map((item) => item.id),
    }),
    authority: JEV_AUTHORITY,
    goal: safeSummary(goal, 1200),
    task: {
      task_id: task.task_id || null,
      task_action: task.task_action || null,
      task_domain: task.task_domain || null,
      criticality: task.criticality || null,
    },
    candidates: projected,
  };

  const validation = validateProjection(projection);
  if (!validation.valid) throw new Error(`JEV_INVALID_PROJECTION:${validation.issues.join(",")}`);
  if (byteLength(projection) > limits.max_projection_bytes) throw new Error("JEV_PROJECTION_TOO_LARGE");
  return projection;
}
