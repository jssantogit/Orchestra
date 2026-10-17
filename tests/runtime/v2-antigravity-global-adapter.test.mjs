import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { normalizeAntigravityActor } from "../../v2/providers/antigravity/actor.mjs";
import { normalizeAntigravityToolEvent } from "../../v2/providers/antigravity/tool-event.mjs";

function hashId(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

test("factual Antigravity root identity becomes hashed provider provenance", () => {
  const actor = normalizeAntigravityActor({ conversation_id: "agy-root-01" });

  assert.deepEqual(actor, {
    provider: "antigravity",
    actorKind: "ROOT",
    actorIdHash: hashId("agy-root-01"),
    isRoot: true,
  });
  assert.equal(JSON.stringify(actor).includes("agy-root-01"), false);
});

test("Antigravity identity hashes the exact provider-supplied bytes", () => {
  const actor = normalizeAntigravityActor({ conversationId: " agy-root-01 " });

  assert.equal(actor.actorIdHash, hashId(" agy-root-01 "));
  assert.notEqual(actor.actorIdHash, hashId("agy-root-01"));
});

test("factual child identity stays distinct and retains factual parent provenance", () => {
  const actor = normalizeAntigravityActor({
    conversationId: "agy-child-01",
    parentConversationId: "agy-root-01",
  });

  assert.deepEqual(actor, {
    provider: "antigravity",
    actorKind: "CHILD",
    actorIdHash: hashId("agy-child-01"),
    parentActorIdHash: hashId("agy-root-01"),
    isRoot: false,
  });
  assert.notEqual(actor.actorIdHash, actor.parentActorIdHash);
});

test("missing or contradictory Antigravity identity aliases fail closed", () => {
  for (const payload of [
    {},
    { conversationId: "" },
    { conversationId: "agy-one", conversation_id: "agy-two" },
    { conversationId: "agy-child", parentConversationId: "agy-parent", parent_conversation_id: "other-parent" },
    { conversationId: "agy-child", parentConversationId: "" },
  ]) {
    assert.throws(() => normalizeAntigravityActor(payload), (error) => {
      assert.equal(error.code, "ANTIGRAVITY_PROVIDER_IDENTITY_INVALID");
      return true;
    });
  }
});

test("role and profile metadata do not change factual root identity", () => {
  const actor = normalizeAntigravityActor({
    conversationId: "agy-root-01",
    role: "SUBAGENT",
    profile: "arbitrary-profile",
  });

  assert.equal(actor.actorKind, "ROOT");
  assert.equal(actor.actorIdHash, hashId("agy-root-01"));
});

test("environment data never supplies missing Antigravity provider identity", () => {
  assert.throws(
    () => normalizeAntigravityActor({}, { conversation_id: "environment-inferred" }),
    (error) => error.code === "ANTIGRAVITY_PROVIDER_IDENTITY_INVALID",
  );
});

test("Antigravity read, write, and command tools map to neutral event classes", () => {
  const identity = { conversationId: "agy-root-01" };
  const read = normalizeAntigravityToolEvent({
    ...identity,
    eventType: "PreToolUse",
    toolCall: { name: "read_file", args: { path: "src/main.mjs" } },
  });
  const write = normalizeAntigravityToolEvent({
    ...identity,
    eventType: "PreToolUse",
    toolCall: { name: "write_file", args: { path: "src/main.mjs" } },
  });
  const command = normalizeAntigravityToolEvent({
    ...identity,
    hook_event_name: "PreToolUse",
    tool_name: "run_command",
  });

  assert.deepEqual([read.operation, read.sideEffectClass], ["READ", "READ_ONLY"]);
  assert.deepEqual([write.operation, write.sideEffectClass], ["WRITE", "WORKSPACE_MUTATION"]);
  assert.deepEqual([command.operation, command.sideEffectClass], ["COMMAND", "UNKNOWN"]);
});

test("unknown side-effecting Antigravity tools remain mutation-protected", () => {
  const event = normalizeAntigravityToolEvent({
    conversationId: "agy-root-01",
    eventType: "PreToolUse",
    toolCall: { name: "unknown_write_everything", args: { path: "secret.txt" } },
  });

  assert.equal(event.operation, "UNKNOWN");
  assert.equal(event.sideEffectClass, "UNKNOWN");
});

test("Antigravity tool correlation preserves factual IDs without truncation or invention", () => {
  const longId = ` call-${"x".repeat(700)} `;
  const event = normalizeAntigravityToolEvent({
    conversation_id: "agy-root-01",
    eventType: "PreToolUse",
    toolCall: { id: longId, name: "write_file" },
  });

  assert.equal(event.factualIds.toolCallId, longId);
  assert.equal(Object.hasOwn(normalizeAntigravityToolEvent({
    conversation_id: "agy-root-01",
    eventType: "PreToolUse",
    toolCall: { name: "write_file" },
  }).factualIds, "toolCallId"), false);
});

test("contradictory Antigravity tool correlation aliases fail closed", () => {
  assert.throws(() => normalizeAntigravityToolEvent({
    conversation_id: "agy-root-01",
    tool_call_id: "call-one",
    toolCallId: "call-two",
    eventType: "PreToolUse",
    toolCall: { name: "write_file" },
  }), (error) => error.code === "ANTIGRAVITY_TOOL_CORRELATION_INVALID");
});
