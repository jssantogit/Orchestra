import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DREAM_SCHEMAS, createDreamEvent, validateDreamRecord } from "./records.mjs";

/**
 * Retrieves and parses a pending decision correlation record.
 *
 * @param {{
 *   repoRoot?: string,
 *   pendingDir?: string,
 *   correlationKey: string,
 * }} options
 * @returns {{ ok: true, pending: Record<string, unknown> } | { ok: false, reason: string, error_code?: string }}
 */
export function getPendingDecision({ repoRoot, pendingDir, correlationKey } = {}) {
  try {
    if (!correlationKey) {
      return { ok: false, reason: "PENDING_NOT_FOUND" };
    }

    const resolvedPendingDir =
      pendingDir ||
      (repoRoot
        ? resolve(repoRoot, ".agents/state/dream/pending-decisions")
        : resolve(".agents/state/dream/pending-decisions"));

    const filePath = join(resolvedPendingDir, `${correlationKey}.json`);
    if (!existsSync(filePath)) {
      return { ok: false, reason: "PENDING_NOT_FOUND" };
    }

    const content = readFileSync(filePath, "utf8");
    const pending = JSON.parse(content);
    return { ok: true, pending };
  } catch (err) {
    return { ok: false, reason: "PENDING_NOT_FOUND", error_code: err.code };
  }
}

/**
 * Records a post-action DECISION_OUTCOME event into telemetry and consumes the pending decision.
 * Idempotent: a second call with the same correlationKey returns OUTCOME_ALREADY_RECORDED and does not write again.
 * Operates under fail-open semantics: any error returns a diagnostic record rather than throwing.
 *
 * @param {{
 *   repoRoot?: string,
 *   telemetryPath?: string,
 *   pendingDir?: string,
 *   correlationKey?: string,
 *   outcome?: Record<string, unknown>,
 * }} options
 * @returns {{
 *   recorded: boolean,
 *   decision_id?: string,
 *   observation_id?: string,
 *   event_hash?: string,
 *   reason?: string,
 *   error_code?: string,
 *   details?: unknown,
 * }}
 */
export function recordDecisionOutcome({
  repoRoot,
  telemetryPath,
  pendingDir,
  correlationKey,
  outcome = {},
} = {}) {
  try {
    const key = correlationKey || outcome?.correlationKey;
    if (!key) {
      return { recorded: false, reason: "PENDING_DECISION_NOT_FOUND" };
    }

    const resolvedPendingDir =
      pendingDir ||
      (repoRoot
        ? resolve(repoRoot, ".agents/state/dream/pending-decisions")
        : resolve(".agents/state/dream/pending-decisions"));

    const consumedPath = join(resolvedPendingDir, `${key}.consumed`);
    if (existsSync(consumedPath)) {
      return { recorded: false, reason: "OUTCOME_ALREADY_RECORDED" };
    }

    const pendingRes = getPendingDecision({
      pendingDir: resolvedPendingDir,
      correlationKey: key,
    });

    if (!pendingRes.ok) {
      return { recorded: false, reason: "PENDING_DECISION_NOT_FOUND" };
    }

    const pending = pendingRes.pending;

    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      return {
        recorded: false,
        reason: "VALIDATION_FAILED",
        error_code: "ERR_INVALID_OUTCOME_OBJECT",
        details: ["outcome must be a non-null object"],
      };
    }

    if (outcome.decision_id && outcome.decision_id !== pending.decision_id) {
      return {
        recorded: false,
        reason: "DECISION_ID_MISMATCH",
        details: `outcome.decision_id "${outcome.decision_id}" does not match pending "${pending.decision_id}"`,
      };
    }

    const outcomeRecord = {
      schema: DREAM_SCHEMAS.OUTCOME,
      created_at: new Date().toISOString(),
      ...outcome,
      decision_id: pending.decision_id,
      observation_id: outcome.observation_id || `obs-${randomUUID()}`,
    };

    const validation = validateDreamRecord(DREAM_SCHEMAS.OUTCOME, outcomeRecord);
    if (!validation.valid) {
      return {
        recorded: false,
        reason: "VALIDATION_FAILED",
        error_code: "ERR_VALIDATION",
        details: validation.errors,
      };
    }

    const event = createDreamEvent("DECISION_OUTCOME", outcomeRecord);

    const resolvedTelemetryPath =
      telemetryPath ||
      (repoRoot
        ? resolve(repoRoot, ".agents/telemetry/events.jsonl")
        : resolve(".agents/telemetry/events.jsonl"));

    // 1. Append DECISION_OUTCOME event to telemetry file
    mkdirSync(dirname(resolvedTelemetryPath), { recursive: true });
    appendFileSync(resolvedTelemetryPath, JSON.stringify(event) + "\n", "utf8");

    // 2. Consume the pending decision correlation atomically
    const pendingPath = join(resolvedPendingDir, `${key}.json`);
    try {
      renameSync(pendingPath, consumedPath);
    } catch (consumeErr) {
      // If rename fails because target already existed or source disappeared
      if (existsSync(consumedPath)) {
        return { recorded: false, reason: "OUTCOME_ALREADY_RECORDED" };
      }
      throw consumeErr;
    }

    return {
      recorded: true,
      decision_id: event.decision_id,
      observation_id: event.observation_id,
      event_hash: event.event_hash,
    };
  } catch (err) {
    return {
      recorded: false,
      reason: "DREAM_TELEMETRY_WRITE_FAILED",
      error_code: err.code || "ERR_WRITE_FAILED",
      details: err.message,
    };
  }
}
