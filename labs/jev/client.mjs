import {
  DEFAULT_JEV_LIMITS,
  JEV_SCHEMAS,
  validateProjection,
} from "./schemas.mjs";

export const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";

function parseResponse(status, ok, text) {
  if (!ok) throw new Error(`JEV_HTTP_${status}: ${String(text).slice(0, 200)}`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("JEV_MALFORMED_JSON"); }
  if (!parsed || typeof parsed !== "object" || !parsed.answers || typeof parsed.answers !== "object") {
    throw new Error("JEV_RESPONSE_MISSING_ANSWERS");
  }
  return parsed;
}

export function noul(answer, name) {
  const value = answer?.answers?.[name]?.noul;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`JEV_INVALID_NOUL:${name}`);
  }
  return value;
}

export class JevClient {
  constructor({
    apiKey = process.env.TYPESAFE_API_KEY || "",
    model = DEFAULT_JEV_MODEL,
    baseUrl = TYPESAFE_SYSTEM_ONE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_JEV_LIMITS.timeout_ms,
    allowTestEndpoint = false,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("JEV_FETCH_UNAVAILABLE");
    if (!allowTestEndpoint && baseUrl !== TYPESAFE_SYSTEM_ONE_URL) {
      throw new Error("JEV_CUSTOM_ENDPOINT_DENIED");
    }
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async ask(projection, questions, { live = false } = {}) {
    const validation = validateProjection(projection);
    if (!validation.valid) throw new Error(`JEV_INVALID_PROJECTION:${validation.issues.join(",")}`);
    if (projection.schema !== JEV_SCHEMAS.PROJECTION) throw new Error("JEV_PROJECTION_ONLY");
    if (!live) return { skipped: true, reason: "JEV_LIVE_DISABLED", answers: {} };
    if (!this.apiKey) throw new Error("TYPESAFE_API_KEY_NOT_CONFIGURED");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          state: projection,
          questions,
        }),
        signal: controller.signal,
      });
      const parsed = parseResponse(response.status, response.ok, await response.text());
      return {
        ...parsed,
        skipped: false,
        latency_ms: Date.now() - started,
        model: parsed.model || this.model,
      };
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("JEV_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createFakeJevClient(scorer = () => 0.5) {
  return {
    async ask(projection, questions) {
      const answers = {};
      for (const name of Object.keys(questions || {})) {
        answers[name] = { type: "noul", noul: Number(scorer({ projection, name })) };
      }
      return {
        model: "jev-fake",
        answers,
        usage: { input_tokens: 0, output_tokens: 0 },
        latency_ms: 0,
        skipped: false,
      };
    },
  };
}
