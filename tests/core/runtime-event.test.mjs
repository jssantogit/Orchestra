import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeEvent } from "../../core/events/runtime-event.mjs";


test("runtime event is canonical, bounded, and normalizes provider actor hashes", () => {
  const event = createRuntimeEvent({
    type: "TOOL_REQUEST",
    generation: 4,
    taskId: "task-1",
    actor: { provider: "codex", actorIdHash: "sha256:actor" },
    factualRef: "tool:call-7",
  });
  assert.equal(event.schema, "orchestra.runtime-event.v1");
  assert.match(event.eventId, /^event-/);
  assert.deepEqual(event.actor, { provider: "codex", sessionIdHash: "sha256:actor" });
  assert.deepEqual(event.payload, {});
  assert.doesNotMatch(JSON.stringify(event), /call-7/);
});

test("runtime event rejects raw transcript reasoning or output payloads", () => {
  for (const forbidden of [
    { raw: "dump" },
    { transcript: "secret" },
    { reasoning: "chain" },
    { output: "huge tool result" },
  ]) {
    assert.throws(() => createRuntimeEvent({ type: "TOOL_RESULT", generation: 1, payload: forbidden }), /RUNTIME_EVENT_PAYLOAD_NOT_BOUNDED/);
  }
});

test("runtime event rejects invalid generation and missing event type", () => {
  assert.throws(() => createRuntimeEvent({ type: "", generation: 0 }), /RUNTIME_EVENT_TYPE_REQUIRED/);
  assert.throws(() => createRuntimeEvent({ type: "TOOL_REQUEST", generation: -1 }), /RUNTIME_EVENT_GENERATION_INVALID/);
});
