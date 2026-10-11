import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSessionActor as normalizeCodexSessionActor } from "../../providers/codex/adapter/session.mjs";
import { normalizeToolEvent as normalizeCodexToolEvent } from "../../providers/codex/adapter/tool-event.mjs";
import { normalizeSessionActor as normalizeAntigravitySessionActor } from "../../providers/antigravity/adapter/session.mjs";
import { normalizeToolEvent as normalizeAntigravityToolEvent } from "../../providers/antigravity/adapter/tool-event.mjs";

function semanticActor(actor) {
  return { actorKind: actor.actorKind, isRoot: actor.isRoot, hasParent: Boolean(actor.parentActorIdHash) };
}

test("Codex and Antigravity root identities normalize to equivalent provider-neutral semantics", () => {
  const codex = normalizeCodexSessionActor({ session_id: "root-codex" });
  const antigravity = normalizeAntigravitySessionActor({ conversationId: "root-antigravity", role: "ORCHESTRATOR", profile: "flash-orchestrator" });
  assert.deepEqual(semanticActor(codex), { actorKind: "ROOT", isRoot: true, hasParent: false });
  assert.deepEqual(semanticActor(antigravity), semanticActor(codex));
  assert.deepEqual(Object.keys(codex).sort(), ["actorIdHash", "actorKind", "isRoot", "provider"]);
  assert.deepEqual(Object.keys(antigravity).sort(), ["actorIdHash", "actorKind", "isRoot", "provider"]);
});

test("child identities remain attributable without carrying provider raw identity field names", () => {
  const codex = normalizeCodexSessionActor({ session_id: "root-codex", agent_id: "worker-codex" });
  const antigravity = normalizeAntigravitySessionActor({ conversationId: "worker-antigravity", parentConversationId: "root-antigravity", role: "WORKER" });
  assert.deepEqual(semanticActor(codex), { actorKind: "CHILD", isRoot: false, hasParent: true });
  assert.deepEqual(semanticActor(antigravity), semanticActor(codex));
  for (const normalized of [codex, antigravity]) {
    const json = JSON.stringify(normalized);
    assert.doesNotMatch(json, /session_id|conversationId|parentConversationId|agent_id/);
  }
});

test("unknown provider tool events normalize to an explicit denyable UNKNOWN form", () => {
  const codex = normalizeCodexToolEvent({ hook_event_name: "UnexpectedFutureHook", session_id: "root-codex", tool_name: "future_tool" });
  const antigravity = normalizeAntigravityToolEvent({ conversationId: "root-antigravity", eventType: "UnexpectedFutureHook", toolCall: { id: "future-call", name: "future_tool", args: {} } });
  for (const event of [codex, antigravity]) {
    assert.equal(event.eventType, "UNKNOWN");
    assert.equal(event.operation, "UNKNOWN");
    assert.equal(event.sideEffectClass, "UNKNOWN");
    assert.equal(event.target, null);
  }
});

test("normalized tool events never embed raw prompt, output, replacement, or transcript blobs", () => {
  const codex = normalizeCodexToolEvent({ hook_event_name: "PreToolUse", session_id: "root-codex", tool_name: "apply_patch", tool_input: { command: "SECRET_PATCH_BYTES" }, prompt: "SECRET_PROMPT" });
  const antigravity = normalizeAntigravityToolEvent({ conversationId: "root-antigravity", toolCall: { id: "write-1", name: "replace_file_content", args: { path: "src/a.mjs", replacement: "SECRET_REPLACEMENT" } }, output: "SECRET_OUTPUT", transcript: "SECRET_TRANSCRIPT" });
  for (const event of [codex, antigravity]) {
    const json = JSON.stringify(event);
    assert.doesNotMatch(json, /SECRET_PATCH_BYTES|SECRET_PROMPT|SECRET_REPLACEMENT|SECRET_OUTPUT|SECRET_TRANSCRIPT/);
  }
});
