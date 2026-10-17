import { createHash } from "node:crypto";

function identityError() {
  const error = new TypeError("Antigravity hook payload must include a factual conversation identity");
  error.code = "ANTIGRAVITY_PROVIDER_IDENTITY_INVALID";
  return error;
}

function factualAlias(payload, keys, { required = false } = {}) {
  const present = keys.filter((key) => Object.hasOwn(payload, key));
  if (present.length === 0) {
    if (required) throw identityError();
    return null;
  }

  const values = present.map((key) => payload[key]);
  if (values.some((value) => typeof value !== "string" || value.length === 0)) throw identityError();
  if (values.some((value) => value !== values[0])) throw identityError();
  return values[0];
}

function hashId(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function normalizeAntigravityActor(payload = {}, _env = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw identityError();
  const conversationId = factualAlias(payload, ["conversationId", "conversation_id"], { required: true });
  const parentConversationId = factualAlias(payload, ["parentConversationId", "parent_conversation_id"]);
  if (parentConversationId === conversationId) throw identityError();

  return Object.freeze({
    provider: "antigravity",
    actorKind: parentConversationId ? "CHILD" : "ROOT",
    actorIdHash: hashId(conversationId),
    ...(parentConversationId ? { parentActorIdHash: hashId(parentConversationId) } : {}),
    isRoot: !parentConversationId,
  });
}
