import { assertRuntimeEvent } from "../../../core/domain/runtime-event.mjs";

function clean(value, max = 300) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function reference(record = {}) {
  const toolCallId = clean(record.tool_call_id || record.toolCallId || record.tool_call?.id);
  if (toolCallId) return `tool:${toolCallId}`;
  const runId = clean(record.run_id || record.runId);
  if (runId) return `run:${runId}`;
  const executionId = clean(record.execution_id || record.executionId);
  if (executionId) return `execution:${executionId}`;
  return "";
}

export function attachProviderTelemetryReference(event, providerRecord = {}) {
  assertRuntimeEvent(event);
  const providerReference = reference(providerRecord);
  if (!providerReference) throw new TypeError("CODEX_TELEMETRY_REFERENCE_REQUIRED");
  return Object.freeze({
    event,
    providerRef: Object.freeze({ provider: "codex", reference: providerReference }),
  });
}
