/**
 * Token Semantics and Normalization Module for Orchestra Turn Economy Benchmark.
 *
 * Enforces token invariants, classifies counter sources, handles provider-specific
 * cache semantics, and rejects impossible token arithmetic.
 */

export const TOKEN_COUNTER_TYPES = Object.freeze({
  DIRECT_COUNTER: "DIRECT_COUNTER",
  DERIVED_COUNTER: "DERIVED_COUNTER",
  ACCUMULATED_COUNTER: "ACCUMULATED_COUNTER",
  PER_TURN_COUNTER: "PER_TURN_COUNTER",
  SESSION_COUNTER: "SESSION_COUNTER",
  PROVIDER_SPECIFIC: "PROVIDER_SPECIFIC",
  NOT_AVAILABLE: "NOT_AVAILABLE",
  NOT_DERIVABLE: "NOT_DERIVABLE",
});

export const CONFIDENCE_LEVELS = Object.freeze({
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
});

/**
 * Normalizes raw usage events from runtimes into a hardened, standardized representation.
 *
 * Invariants strictly enforced:
 * - uncachedInputTokens must NEVER be negative.
 * - cachedInputTokens <= inputTokens is NEVER assumed unless the provider semantics confirm
 *   both fields share the exact same mathematical basis (e.g. OpenAI / Codex).
 * - If semantics do not permit `input - cached`, uncachedInputTokens is set to `null`
 *   and uncachedSemantics is marked "NOT_DERIVABLE".
 *
 * @param {Object} rawUsage - The raw usage object reported by CLI/API
 * @param {string} runtime - "codex" | "antigravity"
 * @param {Object} [meta={}] - Optional metadata (modelInvocationId, invocationNum, etc.)
 */
export function normalizeUsageEvent(rawUsage, runtime = "antigravity", meta = {}) {
  const normRuntime = String(runtime || "").toLowerCase();

  if (!rawUsage || typeof rawUsage !== "object") {
    return {
      runtime: normRuntime,
      modelInvocationId: meta.modelInvocationId || null,
      status: TOKEN_COUNTER_TYPES.NOT_AVAILABLE,
      confidence: CONFIDENCE_LEVELS.LOW,
      inputTokens: null,
      cachedInputTokens: null,
      uncachedInputTokens: null,
      uncachedSemantics: TOKEN_COUNTER_TYPES.NOT_AVAILABLE,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      classifications: {
        inputTokens: TOKEN_COUNTER_TYPES.NOT_AVAILABLE,
        cachedInputTokens: TOKEN_COUNTER_TYPES.NOT_AVAILABLE,
        uncachedInputTokens: TOKEN_COUNTER_TYPES.NOT_AVAILABLE,
        outputTokens: TOKEN_COUNTER_TYPES.NOT_AVAILABLE,
        reasoningTokens: TOKEN_COUNTER_TYPES.NOT_AVAILABLE,
      },
    };
  }

  if (normRuntime === "codex") {
    return normalizeCodexUsage(rawUsage, meta);
  }

  if (normRuntime === "antigravity") {
    return normalizeAntigravityUsage(rawUsage, meta);
  }

  throw new Error(`Unsupported runtime for token semantics normalization: ${runtime}`);
}

/**
 * Normalizes Codex (OpenAI) usage events.
 *
 * In OpenAI API usage:
 * - `input_tokens` (prompt_tokens) is the total input prompt token count.
 * - `cached_input_tokens` (prompt_tokens_details.cached_tokens) is a guaranteed subset of input_tokens.
 * - Therefore: `uncachedInputTokens = input_tokens - cached_input_tokens` is mathematically valid.
 */
function normalizeCodexUsage(raw, meta = {}) {
  const inputTokens = typeof raw.input_tokens === "number" ? raw.input_tokens : null;
  const cachedInputTokens = typeof raw.cached_input_tokens === "number" ? raw.cached_input_tokens : 0;
  const outputTokens = typeof raw.output_tokens === "number" ? raw.output_tokens : null;
  const reasoningTokens = typeof raw.reasoning_output_tokens === "number"
    ? raw.reasoning_output_tokens
    : (typeof raw.reasoning_tokens === "number" ? raw.reasoning_tokens : null);

  let uncachedInputTokens = null;
  let uncachedSemantics = TOKEN_COUNTER_TYPES.DERIVED_COUNTER;
  let confidence = CONFIDENCE_LEVELS.HIGH;

  if (inputTokens !== null) {
    if (cachedInputTokens > inputTokens) {
      // Invariant violation: OpenAI API guarantees cached <= input.
      // If this ever occurs, fail closed to NOT_DERIVABLE.
      uncachedInputTokens = null;
      uncachedSemantics = TOKEN_COUNTER_TYPES.NOT_DERIVABLE;
      confidence = CONFIDENCE_LEVELS.LOW;
    } else {
      uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
    }
  } else {
    uncachedSemantics = TOKEN_COUNTER_TYPES.NOT_AVAILABLE;
  }

  const totalTokens = (inputTokens !== null && outputTokens !== null)
    ? inputTokens + outputTokens
    : (typeof raw.total_tokens === "number" ? raw.total_tokens : null);

  return {
    runtime: "codex",
    modelInvocationId: meta.modelInvocationId || null,
    status: inputTokens !== null ? "OK" : TOKEN_COUNTER_TYPES.NOT_AVAILABLE,
    confidence,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    uncachedSemantics,
    outputTokens,
    reasoningTokens,
    totalTokens,
    classifications: {
      inputTokens: TOKEN_COUNTER_TYPES.ACCUMULATED_COUNTER,
      cachedInputTokens: TOKEN_COUNTER_TYPES.ACCUMULATED_COUNTER,
      uncachedInputTokens: uncachedSemantics,
      outputTokens: TOKEN_COUNTER_TYPES.ACCUMULATED_COUNTER,
      reasoningTokens: TOKEN_COUNTER_TYPES.ACCUMULATED_COUNTER,
      totalTokens: TOKEN_COUNTER_TYPES.ACCUMULATED_COUNTER,
    },
    rawObservation: {
      input_tokens: raw.input_tokens ?? null,
      cached_input_tokens: raw.cached_input_tokens ?? null,
      cache_write_input_tokens: raw.cache_write_input_tokens ?? null,
      output_tokens: raw.output_tokens ?? null,
      reasoning_output_tokens: raw.reasoning_output_tokens ?? null,
    },
  };
}

/**
 * Normalizes Antigravity (Gemini) usage events.
 *
 * In Antigravity / Gemini CLI output:
 * - `input_tokens`: The session prompt tokens reported by the CLI.
 * - `cache_read_tokens`: Tokens served from the Gemini context cache across turns.
 * - `total_tokens`: Exactly equal to `input_tokens + output_tokens`.
 *
 * CRITICAL DISCOVERY:
 * `cache_read_tokens` is NOT a subset of `input_tokens`!
 * For example in Task 3: input_tokens = 166,925, cache_read_tokens = 223,111,
 * and total_tokens = 173,236 (166,925 + 6,311).
 * Performing `input_tokens - cache_read_tokens` produces an impossible negative value (-56,186).
 *
 * Therefore:
 * - uncachedInputTokens CANNOT be derived via subtraction.
 * - uncachedInputTokens is set to null.
 * - uncachedSemantics is marked "NOT_DERIVABLE".
 * - Both counters are preserved independently without corruption.
 */
function normalizeAntigravityUsage(raw, meta = {}) {
  const inputTokens = typeof raw.input_tokens === "number" ? raw.input_tokens : null;
  const cacheReadTokens = typeof raw.cache_read_tokens === "number"
    ? raw.cache_read_tokens
    : (typeof raw.cached_input_tokens === "number" ? raw.cached_input_tokens : null);
  const outputTokens = typeof raw.output_tokens === "number" ? raw.output_tokens : null;
  const thinkingTokens = typeof raw.thinking_tokens === "number"
    ? raw.thinking_tokens
    : (typeof raw.reasoning_tokens === "number" ? raw.reasoning_tokens : null);

  const totalTokens = typeof raw.total_tokens === "number"
    ? raw.total_tokens
    : ((inputTokens !== null && outputTokens !== null) ? inputTokens + outputTokens : null);

  // Invariant check: In AGY, cache_read_tokens is an independent counter.
  // We strictly refuse to perform `inputTokens - cacheReadTokens`.
  const uncachedInputTokens = null;
  const uncachedSemantics = TOKEN_COUNTER_TYPES.NOT_DERIVABLE;

  return {
    runtime: "antigravity",
    modelInvocationId: meta.modelInvocationId || null,
    status: inputTokens !== null ? "OK" : TOKEN_COUNTER_TYPES.NOT_AVAILABLE,
    confidence: CONFIDENCE_LEVELS.MEDIUM,
    inputTokens,
    cachedInputTokens: cacheReadTokens,
    uncachedInputTokens,
    uncachedSemantics,
    outputTokens,
    reasoningTokens: thinkingTokens,
    totalTokens,
    classifications: {
      inputTokens: TOKEN_COUNTER_TYPES.ACCUMULATED_COUNTER,
      cachedInputTokens: TOKEN_COUNTER_TYPES.PROVIDER_SPECIFIC,
      uncachedInputTokens: TOKEN_COUNTER_TYPES.NOT_DERIVABLE,
      outputTokens: TOKEN_COUNTER_TYPES.ACCUMULATED_COUNTER,
      reasoningTokens: TOKEN_COUNTER_TYPES.ACCUMULATED_COUNTER,
      totalTokens: TOKEN_COUNTER_TYPES.ACCUMULATED_COUNTER,
    },
    rawObservation: {
      input_tokens: raw.input_tokens ?? null,
      output_tokens: raw.output_tokens ?? null,
      thinking_tokens: raw.thinking_tokens ?? raw.reasoning_tokens ?? null,
      cache_read_tokens: raw.cache_read_tokens ?? raw.cached_input_tokens ?? null,
      total_tokens: raw.total_tokens ?? null,
    },
    notes: "cache_read_tokens is an independent Gemini context cache counter and is not a subset of input_tokens. Subtraction is prohibited to prevent impossible negative values.",
  };
}
