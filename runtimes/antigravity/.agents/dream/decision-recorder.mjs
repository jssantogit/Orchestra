import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DREAM_SCHEMAS, createDreamEvent, validateDreamRecord } from "./records.mjs";

/**
 * Builds a deterministic safe filesystem key string for correlating decisions with outcomes.
 *
 * @param {{
 *   conversationId?: string,
 *   stepIdx?: number | string,
 *   toolCallId?: string,
 *   branchOrdinal?: number | string,
 * }} params
 * @returns {string}
 */
export function dreamCorrelationKey({
  conversationId = "",
  stepIdx = 0,
  toolCallId = "",
  branchOrdinal = 0,
} = {}) {
  const encConv = encodeURIComponent(String(conversationId ?? ""));
  const sIdx = String(stepIdx ?? 0);
  const encTool = encodeURIComponent(String(toolCallId ?? ""));
  const bOrd = String(branchOrdinal ?? 0);
  return `dec-${encConv}_${sIdx}_${encTool}_${bOrd}`;
}

/**
 * Records a pre-action DECISION event into telemetry and atomically persists a pending correlation file.
 * Operates under fail-open semantics: any error returns a diagnostic record rather than throwing.
 *
 * @param {{
 *   repoRoot?: string,
 *   telemetryPath?: string,
 *   pendingDir?: string,
 *   snapshot?: unknown,
 *   decision?: Record<string, unknown>,
 *   correlationKey?: string,
 * }} options
 * @returns {{
 *   recorded: boolean,
 *   decision_id?: string,
 *   event_hash?: string,
 *   correlationKey?: string,
 *   reason?: string,
 *   error_code?: string,
 *   details?: unknown,
 * }}
 */
export function recordDecision({
  repoRoot,
  telemetryPath,
  pendingDir,
  snapshot,
  decision = {},
  correlationKey,
} = {}) {
  try {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      return {
        recorded: false,
        reason: "VALIDATION_FAILED",
        error_code: "ERR_INVALID_DECISION_OBJECT",
        details: ["decision must be a non-null object"],
      };
    }

    const decision_id = decision.decision_id || `dec-${randomUUID()}`;
    const snapshot_id =
      decision.snapshot_id ||
      (typeof snapshot === "string" ? snapshot : snapshot?.snapshot_id);

    const decisionRecord = {
      schema: DREAM_SCHEMAS.DECISION,
      created_at: new Date().toISOString(),
      ...decision,
      decision_id,
      snapshot_id,
    };

    const validation = validateDreamRecord(DREAM_SCHEMAS.DECISION, decisionRecord);
    if (!validation.valid) {
      return {
        recorded: false,
        reason: "VALIDATION_FAILED",
        error_code: "ERR_VALIDATION",
        details: validation.errors,
      };
    }

    const effectiveCorrelationKey =
      correlationKey ||
      (decisionRecord.conversation_id != null || decisionRecord.tool_call_id != null
        ? dreamCorrelationKey({
            conversationId: decisionRecord.conversation_id,
            stepIdx: decisionRecord.step_idx,
            toolCallId: decisionRecord.tool_call_id,
            branchOrdinal: decisionRecord.branch_ordinal,
          })
        : decision_id);

    const event = createDreamEvent("DECISION", decisionRecord);

    const resolvedTelemetryPath =
      telemetryPath ||
      (repoRoot
        ? resolve(repoRoot, ".agents/telemetry/events.jsonl")
        : resolve(".agents/telemetry/events.jsonl"));

    const resolvedPendingDir =
      pendingDir ||
      (repoRoot
        ? resolve(repoRoot, ".agents/state/dream/pending-decisions")
        : resolve(".agents/state/dream/pending-decisions"));

    // 1. Append DECISION event to telemetry file
    mkdirSync(dirname(resolvedTelemetryPath), { recursive: true });
    appendFileSync(resolvedTelemetryPath, JSON.stringify(event) + "\n", "utf8");

    // 2. Persist pending correlation file atomically
    mkdirSync(resolvedPendingDir, { recursive: true });

    const pendingData = {
      decision_id: event.decision_id,
      snapshot_id: event.snapshot_id,
      decision_type: event.decision_type,
      chosen_action: event.chosen_action,
      conversation_id: decisionRecord.conversation_id ?? null,
      step_idx: decisionRecord.step_idx ?? null,
      tool_call_id: decisionRecord.tool_call_id ?? null,
      branch_ordinal: decisionRecord.branch_ordinal ?? null,
      created_at: event.created_at,
      event_hash: event.event_hash,
    };

    const targetFile = join(resolvedPendingDir, `${effectiveCorrelationKey}.json`);
    const tempFile = join(
      resolvedPendingDir,
      `.${effectiveCorrelationKey}.${randomUUID()}.tmp`,
    );

    try {
      writeFileSync(tempFile, JSON.stringify(pendingData, null, 2), "utf8");
      renameSync(tempFile, targetFile);
    } catch (writeErr) {
      try {
        unlinkSync(tempFile);
      } catch {}
      throw writeErr;
    }

    return {
      recorded: true,
      decision_id: event.decision_id,
      event_hash: event.event_hash,
      correlationKey: effectiveCorrelationKey,
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
