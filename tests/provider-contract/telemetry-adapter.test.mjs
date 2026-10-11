import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeEvent } from "../../core/events/runtime-event.mjs";
import { attachProviderTelemetryReference as attachCodex } from "../../providers/codex/adapter/telemetry.mjs";
import { attachProviderTelemetryReference as attachAntigravity } from "../../providers/antigravity/adapter/telemetry.mjs";

const event = createRuntimeEvent({ type: "TOOL_RESULT", generation: 2, taskId: "task-1" });

test("provider telemetry adapters keep factual references outside canonical runtime events", () => {
  const codex = attachCodex(event, { tool_call_id: "call-7", output: "must-not-copy" });
  const antigravity = attachAntigravity(event, { toolCall: { id: "tool-9" }, reasoning: "must-not-copy" });
  assert.deepEqual(codex.providerRef, { provider: "codex", reference: "tool:call-7" });
  assert.deepEqual(antigravity.providerRef, { provider: "antigravity", reference: "tool:tool-9" });
  assert.deepEqual(codex.event.payload, {});
  assert.doesNotMatch(JSON.stringify(codex), /must-not-copy/);
  assert.doesNotMatch(JSON.stringify(antigravity), /must-not-copy/);
});

test("provider telemetry adapters require a bounded factual reference", () => {
  assert.throws(() => attachCodex(event, {}), /CODEX_TELEMETRY_REFERENCE_REQUIRED/);
  assert.throws(() => attachAntigravity(event, {}), /ANTIGRAVITY_TELEMETRY_REFERENCE_REQUIRED/);
});
