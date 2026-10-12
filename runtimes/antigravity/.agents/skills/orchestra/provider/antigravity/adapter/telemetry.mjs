import { assertRuntimeEvent } from "../../../core/domain/runtime-event.mjs";

function clean(value, max = 300) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function reference(record = {}) {
  const toolCall = record.toolCall || record.tool_call || {};
  const toolCallId = clean(toolCall.id || record.toolCallId || record.tool_call_id);
  if (toolCallId) return `tool:${toolCallId}`;
  const executionId = clean(record.executionId || record.execution_id);
  if (executionId) return `execution:${executionId}`;
  const step = Number.isInteger(record.stepIdx) ? record.stepIdx : (Number.isInteger(record.step_idx) ? record.step_idx : null);
  if (step !== null) return `step:${step}`;
  return "";
}

export function attachProviderTelemetryReference(event, providerRecord = {}) {
  assertRuntimeEvent(event);
  const providerReference = reference(providerRecord);
  if (!providerReference) throw new TypeError("ANTIGRAVITY_TELEMETRY_REFERENCE_REQUIRED");
  return Object.freeze({
    event,
    providerRef: Object.freeze({ provider: "antigravity", reference: providerReference }),
  });
}
