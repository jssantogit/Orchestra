import { createHash } from "node:crypto";

export const CODEX_PACKET_SCHEMA = "orchestra.codex-worker-packet.v1";
export const CODEX_CONTEXT_LIMITS = Object.freeze({
  max_auxiliary_refs: 8,
  max_auxiliary_bytes: 16384,
  max_inline_output_bytes: 65536,
  max_inline_output_lines: 300,
  large_file_bytes: 200 * 1024,
  default_window_lines: 160,
});

const FORBIDDEN_KEYS = new Set([
  "transcript", "transcripts", "messages", "prompt", "prompts",
  "reasoning", "thinking", "chainOfThought", "chain_of_thought",
  "stdout", "stderr", "raw", "rawContent", "raw_content", "credentials",
  "secret", "secrets", "environment", "env",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function assertSafe(value, path = "packet") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafe(item, path + "[" + index + "]"));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error("CODEX_PACKET_FORBIDDEN_FIELD:" + path + "." + key);
    }
    assertSafe(child, path + "." + key);
  }
}

function cleanString(value, max = 480) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeRef(raw = {}) {
  const ref = {
    id: cleanString(raw.id || raw.evidenceId || raw.ref || "", 160),
    kind: cleanString(raw.kind || raw.type || "REFERENCE", 64).toUpperCase(),
    path: cleanString(raw.path || "", 320) || null,
    symbol: cleanString(raw.symbol || "", 240) || null,
    summary: cleanString(raw.summary || raw.label || "", 480) || null,
    priority: Number.isFinite(raw.priority) ? Number(raw.priority) : 0,
    pinned: raw.pinned === true,
  };
  if (!ref.id && !ref.path && !ref.symbol) throw new Error("CODEX_PACKET_REFERENCE_ID_REQUIRED");
  return ref;
}

function refBytes(ref) {
  return Buffer.byteLength(JSON.stringify(ref), "utf8");
}

export function selectCodexAuxiliaryRefs(refs = [], limits = CODEX_CONTEXT_LIMITS) {
  const normalized = refs.map(normalizeRef);
  const deduped = [...new Map(normalized.map((ref) => [
    ref.id || ref.path || ref.symbol,
    ref,
  ])).values()];
  deduped.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return String(a.id || a.path || a.symbol).localeCompare(String(b.id || b.path || b.symbol));
  });

  const selected = [];
  let bytes = 0;
  for (const ref of deduped) {
    const size = refBytes(ref);
    if (ref.pinned) {
      selected.push(ref);
      bytes += size;
      continue;
    }
    if (selected.length >= limits.max_auxiliary_refs) continue;
    if (bytes + size > limits.max_auxiliary_bytes) continue;
    selected.push(ref);
    bytes += size;
  }
  return { selected, bytes, totalCandidates: deduped.length };
}

export function createCodexWorkerPacket({
  task = {},
  scopeContract = {},
  activeState = {},
  auxiliaryRefs = [],
  limits = CODEX_CONTEXT_LIMITS,
} = {}) {
  const mandatoryCore = {
    task: {
      task_id: activeState.taskId || task.taskId || null,
      action: activeState.taskAction || task.taskAction || scopeContract.taskAction || null,
      domain: activeState.taskDomain || task.taskDomain || scopeContract.taskDomain || null,
      criticality: activeState.criticality || scopeContract.criticality || "NORMAL",
      goal: cleanString(task.goal || task.task || "", 1200) || null,
    },
    scope: {
      allowed_paths: Array.isArray(scopeContract.allowedPaths) ? [...scopeContract.allowedPaths] : [],
      forbidden_paths: Array.isArray(scopeContract.forbiddenPaths) ? [...scopeContract.forbiddenPaths] : [],
      acceptance_criteria: Array.isArray(scopeContract.acceptanceCriteria) ? [...scopeContract.acceptanceCriteria] : [],
      tests_required: Array.isArray(scopeContract.testsRequired) ? [...scopeContract.testsRequired] : [],
      required_evidence: Array.isArray(scopeContract.requiredEvidence) ? stable(scopeContract.requiredEvidence) : [],
      side_effect_capabilities: Array.isArray(scopeContract.sideEffectCapabilities)
        ? [...scopeContract.sideEffectCapabilities]
        : [],
      stop_conditions: Array.isArray(scopeContract.stopConditions) ? [...scopeContract.stopConditions] : [],
    },
    runtime: {
      state: activeState.state || null,
      attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
      retry_remaining: activeState.retry_remaining ?? activeState.retryRemaining ?? null,
      mutation_seq: activeState.mutationSeq ?? activeState.mutation_seq ?? 0,
      blockers: Array.isArray(activeState.blockers) ? [...activeState.blockers] : [],
      human_gate_reason: activeState.humanGateReason || null,
    },
  };
  assertSafe(mandatoryCore);

  const auxiliary = selectCodexAuxiliaryRefs(auxiliaryRefs, limits);
  const body = {
    schema: CODEX_PACKET_SCHEMA,
    mandatory_core: mandatoryCore,
    auxiliary_refs: auxiliary.selected,
    budget: {
      auxiliary_bytes: auxiliary.bytes,
      auxiliary_candidates: auxiliary.totalCandidates,
      auxiliary_selected: auxiliary.selected.length,
    },
  };
  assertSafe(body);
  return { ...body, packet_id: "codex-packet-" + hash(body).slice(0, 24) };
}

export function evaluateCodexOutputGate({ bytes = 0, lines = 0 } = {}, limits = CODEX_CONTEXT_LIMITS) {
  const overBytes = Number(bytes || 0) > limits.max_inline_output_bytes;
  const overLines = Number(lines || 0) > limits.max_inline_output_lines;
  return {
    inline_allowed: !overBytes && !overLines,
    action: overBytes || overLines ? "PERSIST_AND_REFERENCE" : "INLINE",
    over_bytes: overBytes,
    over_lines: overLines,
    max_bytes: limits.max_inline_output_bytes,
    max_lines: limits.max_inline_output_lines,
  };
}

export function searchToWindowDecision({
  fileBytes = 0,
  knownSymbol = null,
  knownLine = null,
  matchCount = null,
  limits = CODEX_CONTEXT_LIMITS,
} = {}) {
  const large = Number(fileBytes || 0) > limits.large_file_bytes;
  const hasAnchor = Boolean(knownSymbol) || Number.isInteger(knownLine);
  return {
    large_file: large,
    search_first: large && !hasAnchor,
    action: large && !hasAnchor ? "SEARCH_THEN_WINDOW" : "TARGETED_WINDOW",
    suggested_window_lines: limits.default_window_lines,
    match_count: Number.isInteger(matchCount) ? matchCount : null,
  };
}

export function assertCodexPacketSafe(packet) {
  try {
    assertSafe(packet);
    return { valid: true, reason: null };
  } catch (error) {
    return { valid: false, reason: String(error.message || error) };
  }
}
