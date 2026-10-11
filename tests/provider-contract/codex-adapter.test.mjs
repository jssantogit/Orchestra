import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { normalizeSessionActor } from "../../providers/codex/adapter/session.mjs";
import { normalizeToolEvent } from "../../providers/codex/adapter/tool-event.mjs";
import { normalizeProviderEvidence } from "../../providers/codex/adapter/evidence.mjs";
import { validateEvidence } from "../../core/domain/evidence.mjs";

function hash(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

test("Codex session payload normalizes factual root identity without leaking raw session id", () => {
  const actor = normalizeSessionActor({ hook_event_name: "SessionStart", source: "startup", session_id: "codex-root-a" });
  assert.deepEqual(actor, { provider: "codex", actorIdHash: hash("codex-root-a"), actorKind: "ROOT", isRoot: true });
  assert.doesNotMatch(JSON.stringify(actor), /codex-root-a/);
});

test("Codex agent_id remains attributable as a child of the factual root session", () => {
  const actor = normalizeSessionActor({ session_id: "codex-root-a", agent_id: "worker-17" });
  assert.deepEqual(actor, { provider: "codex", actorIdHash: hash("worker-17"), actorKind: "CHILD", parentActorIdHash: hash("codex-root-a"), isRoot: false });
});

test("Codex tool events normalize read, mutation, and unsupported tools distinctly", () => {
  const read = normalizeToolEvent({ hook_event_name: "PreToolUse", session_id: "codex-root-a", tool_call_id: "call-read-1", tool_name: "Read", tool_input: { file_path: "src/app.mjs" } });
  assert.deepEqual(read, { eventType: "TOOL_REQUEST", operation: "READ", target: "src/app.mjs", sideEffectClass: "READ_ONLY", factualIds: { actorIdHash: hash("codex-root-a"), toolCallId: "call-read-1" }, rawRef: "codex:PreToolUse:call-read-1" });

  const write = normalizeToolEvent({ hook_event_name: "PreToolUse", session_id: "codex-root-a", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } });
  assert.equal(write.operation, "WRITE");
  assert.equal(write.sideEffectClass, "WORKSPACE_MUTATION");
  assert.equal(write.target, "workspace");

  const unknown = normalizeToolEvent({ hook_event_name: "PreToolUse", session_id: "codex-root-a", tool_name: "brand_new_tool" });
  assert.equal(unknown.eventType, "TOOL_REQUEST");
  assert.equal(unknown.operation, "UNKNOWN");
  assert.equal(unknown.sideEffectClass, "UNKNOWN");
  assert.equal(unknown.target, null);
});

test("Codex evidence normalizes into canonical Evidence and provider-owned factual reference", () => {
  const evidence = normalizeProviderEvidence({ taskId: "task-1", candidateId: "candidate-7", candidateGeneration: 3, kind: "REMOTE_CI", conclusion: "success", run_id: 38159397967 });
  assert.deepEqual(evidence, { schema: "orchestra.evidence.v1", taskId: "task-1", candidateId: "candidate-7", candidateGeneration: 3, kind: "REMOTE_CI", status: "PASSED", source: { provider: "codex", reference: "run:38159397967" } });
  assert.deepEqual(validateEvidence(evidence), { valid: true, errors: [] });
});

test("Codex adapters fail closed when factual identity or evidence reference is missing", () => {
  assert.throws(() => normalizeSessionActor({}), /CODEX_SESSION_ID_REQUIRED/);
  assert.throws(() => normalizeToolEvent({ hook_event_name: "PreToolUse", tool_name: "Read" }), /CODEX_SESSION_ID_REQUIRED/);
  assert.throws(() => normalizeProviderEvidence({ taskId: "task-1", candidateId: "candidate-1", candidateGeneration: 0, kind: "REMOTE_CI", conclusion: "success" }), /CODEX_EVIDENCE_REFERENCE_REQUIRED/);
});
