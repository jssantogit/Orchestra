import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DREAM_SCHEMAS, createDreamEvent, validateDreamRecord } from "./records.mjs";
import {
  isSafeDreamCorrelationKey,
  findRecordedDecision,
  validatePendingDecisionArtifact,
} from "./decision-recorder.mjs";
import { sha256Canonical } from "./canonical.mjs";

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
    if (!isSafeDreamCorrelationKey(correlationKey)) {
      return { ok: false, reason: "UNSAFE_CORRELATION_KEY", error_code: "ERR_UNSAFE_CORRELATION_KEY" };
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

function findRecordedOutcome(telemetryPath, decisionId) {
  try {
    if (!telemetryPath || !decisionId || !existsSync(telemetryPath)) return null;
    const lines = readFileSync(telemetryPath, "utf8").split("\n");
    for (let idx = lines.length - 1; idx >= 0; idx--) {
      const line = lines[idx].trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event?.type === "DECISION_OUTCOME" && event?.decision_id === decisionId) {
          return event;
        }
      } catch {}
    }
  } catch {}
  return null;
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
    if (!isSafeDreamCorrelationKey(key)) {
      return {
        recorded: false,
        reason: "VALIDATION_FAILED",
        error_code: "ERR_UNSAFE_CORRELATION_KEY",
        details: ["correlationKey must be a safe single filesystem segment <= 220 UTF-8 bytes"],
      };
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
    const pendingIntegrity = validatePendingDecisionArtifact(pending);
    if (!pendingIntegrity.valid) {
      return {
        recorded: false,
        reason: "PENDING_DECISION_CORRUPT",
        error_code: "ERR_PENDING_DECISION_CORRUPT",
        details: pendingIntegrity.errors,
      };
    }

    const resolvedTelemetryPath =
      telemetryPath ||
      (repoRoot
        ? resolve(repoRoot, ".agents/telemetry/events.jsonl")
        : resolve(".agents/telemetry/events.jsonl"));

    // Ensure the causal DECISION is durably published before any outcome.
    // A crash may leave a valid pending artifact after its atomic rename but
    // before telemetry append; recover that exact event here.
    const publishedDecision = findRecordedDecision(resolvedTelemetryPath, pending.decision_id);
    if (publishedDecision) {
      const publishedIntegrity = validatePendingDecisionArtifact({
        ...pending,
        event_hash: publishedDecision.event_hash,
        decision_event: publishedDecision,
      });
      if (!publishedIntegrity.valid || publishedDecision.event_hash !== pending.event_hash) {
        return {
          recorded: false,
          reason: "PUBLISHED_DECISION_MISMATCH",
          error_code: "ERR_PUBLISHED_DECISION_MISMATCH",
          details: publishedIntegrity.errors,
        };
      }
    } else {
      mkdirSync(dirname(resolvedTelemetryPath), { recursive: true });
      appendFileSync(resolvedTelemetryPath, JSON.stringify(pending.decision_event) + "\n", "utf8");
    }

    // Crash/retry recovery: if the outcome event was already appended but the
    // pending->consumed rename did not complete, finalize consumption without
    // appending a duplicate telemetry event.
    const existingOutcome = findRecordedOutcome(resolvedTelemetryPath, pending.decision_id);
    if (existingOutcome) {
      const outcomeValidation = validateDreamRecord(DREAM_SCHEMAS.OUTCOME, existingOutcome);
      const { event_hash: existingHash, ...existingBase } = existingOutcome;
      let recomputedExistingHash = null;
      try { recomputedExistingHash = sha256Canonical(existingBase); } catch {}
      if (
        !outcomeValidation.valid ||
        !existingHash ||
        recomputedExistingHash !== existingHash ||
        existingOutcome.decision_id !== pending.decision_id
      ) {
        return {
          recorded: false,
          reason: "PUBLISHED_OUTCOME_CORRUPT",
          error_code: "ERR_PUBLISHED_OUTCOME_CORRUPT",
          details: outcomeValidation.errors,
        };
      }

      const pendingPath = join(resolvedPendingDir, `${key}.json`);
      try {
        renameSync(pendingPath, consumedPath);
      } catch (consumeErr) {
        if (!existsSync(consumedPath)) {
          return {
            recorded: false,
            reason: "OUTCOME_RECOVERY_FAILED",
            error_code: consumeErr.code || "ERR_RECOVERY_FAILED",
            details: consumeErr.message,
          };
        }
      }
      return {
        recorded: false,
        reason: "OUTCOME_ALREADY_RECORDED",
        decision_id: existingOutcome.decision_id,
        observation_id: existingOutcome.observation_id,
        event_hash: existingOutcome.event_hash,
        recovered: true,
      };
    }

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
