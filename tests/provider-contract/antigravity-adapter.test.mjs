import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { normalizeSessionActor } from "../../providers/antigravity/adapter/session.mjs";
import { normalizeToolEvent } from "../../providers/antigravity/adapter/tool-event.mjs";
import { normalizeProviderEvidence } from "../../providers/antigravity/adapter/evidence.mjs";
import { validateEvidence } from "../../core/domain/evidence.mjs";

function hash(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

test("Antigravity conversation payload normalizes factual root identity without leaking raw id", () => {
  const actor = normalizeSessionActor({ conversationId: "agy-root-a", role: "ORCHESTRATOR", profile: "flash-orchestrator" });
  assert.deepEqual(actor, { provider: "antigravity", actorIdHash: hash("agy-root-a"), actorKind: "ROOT", isRoot: true });
  assert.doesNotMatch(JSON.stringify(actor), /agy-root-a/);
});

test("Antigravity parentConversationId preserves child attribution", () => {
  const actor = normalizeSessionActor({ conversationId: "agy-child-9", parentConversationId: "agy-root-a", role: "WORKER", profile: "flash-medium-worker" });
  assert.deepEqual(actor, { provider: "antigravity", actorIdHash: hash("agy-child-9"), actorKind: "CHILD", parentActorIdHash: hash("agy-root-a"), isRoot: false });
});

test("Antigravity tool calls normalize read, mutation, and unsupported operations distinctly", () => {
  const read = normalizeToolEvent({ conversationId: "agy-root-a", toolCall: { id: "call-view-1", name: "view_file", args: { path: "src/app.mjs" } } });
  assert.deepEqual(read, { eventType: "TOOL_REQUEST", operation: "READ", target: "src/app.mjs", sideEffectClass: "READ_ONLY", factualIds: { actorIdHash: hash("agy-root-a"), toolCallId: "call-view-1" }, rawRef: "antigravity:tool:call-view-1" });

  const write = normalizeToolEvent({ conversationId: "agy-root-a", toolCall: { id: "call-write-1", name: "replace_file_content", args: { path: "src/app.mjs", replacement: "ignored raw content" } } });
  assert.equal(write.operation, "WRITE");
  assert.equal(write.sideEffectClass, "WORKSPACE_MUTATION");
  assert.equal(write.target, "src/app.mjs");
  assert.doesNotMatch(JSON.stringify(write), /ignored raw content/);

  const unknown = normalizeToolEvent({ conversationId: "agy-root-a", toolCall: { id: "call-new", name: "future_tool", args: {} } });
  assert.equal(unknown.eventType, "TOOL_REQUEST");
  assert.equal(unknown.operation, "UNKNOWN");
  assert.equal(unknown.sideEffectClass, "UNKNOWN");
  assert.equal(unknown.target, null);
});

test("Antigravity evidence normalizes into canonical Evidence", () => {
  const evidence = normalizeProviderEvidence({ task_id: "task-2", candidate_id: "candidate-4", candidate_generation: 2, kind: "LOCAL_COMMAND", result: "SUCCESS", toolCallId: "call-test-8" });
  assert.deepEqual(evidence, { schema: "orchestra.evidence.v1", taskId: "task-2", candidateId: "candidate-4", candidateGeneration: 2, kind: "LOCAL_COMMAND", status: "PASSED", source: { provider: "antigravity", reference: "tool:call-test-8" } });
  assert.deepEqual(validateEvidence(evidence), { valid: true, errors: [] });
});

test("Antigravity adapters fail closed when factual identity or evidence reference is missing", () => {
  assert.throws(() => normalizeSessionActor({}), /ANTIGRAVITY_CONVERSATION_ID_REQUIRED/);
  assert.throws(() => normalizeToolEvent({ toolCall: { id: "call-x", name: "view_file", args: {} } }), /ANTIGRAVITY_CONVERSATION_ID_REQUIRED/);
  assert.throws(() => normalizeProviderEvidence({ task_id: "task-2", candidate_id: "candidate-4", candidate_generation: 2, kind: "LOCAL_COMMAND", result: "SUCCESS" }), /ANTIGRAVITY_EVIDENCE_REFERENCE_REQUIRED/);
});
