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


test("Codex native collaboration names classify delegation without classifying arbitrary tools", () => {
  const base = { hook_event_name: "PreToolUse", session_id: "root-155", tool_call_id: "native-155" };
  for (const name of ["collaborationspawn_agent", "spawn_agent", "multi_agent_v1spawn_agent"]) {
    const result = normalizeToolEvent({ ...base, tool_name: name, tool_input: { agent_type: "luna-max" } });
    assert.equal(result.operation, "DELEGATE", name);
    assert.equal(result.sideEffectClass, "DELEGATION", name);
    assert.equal(result.target, "luna-max");
  }
  for (const name of ["collaborationwait_agent", "collaborationfollowup_task", "collaborationlist_agents", "collaborationinterrupt_agent", "multi_agent_v1wait_agent", "multi_agent_v1send_input", "multi_agent_v1close_agent"]) {
    const result = normalizeToolEvent({ ...base, tool_name: name, tool_input: { target: "worker-1" } });
    assert.equal(result.operation, "AGENT_CONTROL", name);
    assert.equal(result.sideEffectClass, "DELEGATION", name);
  }
  for (const name of ["collaborationdangerous_tool", "spawn_everyone", "unknown_operation"]) {
    assert.equal(normalizeToolEvent({ ...base, tool_name: name }).operation, "UNKNOWN", name);
  }
});


test("native Codex factual web, clarification and message tools have explicit classes; unknown tools remain unknown", () => {
  const base = { hook_event_name: "PreToolUse", session_id: "root-155", tool_call_id: "field-155" };
  for (const [tool_name, operation, sideEffectClass] of [
    ["webrun", "WEB_RESEARCH", "NETWORK_READ"],
    ["request_user_input_async", "USER_CLARIFICATION", "HUMAN_INTERACTION"],
    ["send_message", "AGENT_MESSAGE", "DELEGATION"],
  ]) {
    const e = normalizeToolEvent({ ...base, tool_name, tool_input: {} });
    assert.equal(e.operation, operation, tool_name);
    assert.equal(e.sideEffectClass, sideEffectClass, tool_name);
    assert.equal(e.factualIds.toolCallId, "field-155");
  }
  for (const tool_name of ["webrun_unsafe", "request_user_input_async_custom", "send_message_everyone", "tool_created_later"]) {
    assert.equal(normalizeToolEvent({ ...base, tool_name }).operation, "UNKNOWN", tool_name);
  }
});


test("Codex 0.164 collaboration send_message is a bounded message, not child delegation control", () => {
  const field = normalizeToolEvent({
    hook_event_name: "PreToolUse", session_id: "real-root", agent_id: "luna-field",
    tool_name: "collaborationsend_message", tool_call_id: "child-message-1",
    tool_input: { target: "parent", message: "Finished tests" },
  });
  assert.equal(field.operation, "AGENT_MESSAGE");
  assert.equal(field.sideEffectClass, "DELEGATION");
  assert.equal(field.target, "parent");
  assert.equal(field.factualIds.toolCallId, "child-message-1");
  assert.equal(normalizeToolEvent({
    hook_event_name: "PreToolUse", session_id: "real-root", agent_id: "luna-field",
    tool_name: "collaborationwait_agent", tool_input: { target: "parent" },
  }).operation, "AGENT_CONTROL");
});
