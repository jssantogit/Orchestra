import { createHash } from "node:crypto";

function clean(value, max = 300) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function hashId(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function rootCompatible({ parentConversationId = "", role = "", profile = "" } = {}) {
  if (parentConversationId) return false;
  const normalizedRole = role.toUpperCase();
  const normalizedProfile = profile.toLowerCase();
  if (normalizedRole && !["ORCHESTRATOR", "CONTROL", "ROOT"].includes(normalizedRole)) return false;
  if (normalizedProfile && normalizedProfile !== "flash-orchestrator") return false;
  return true;
}

export function normalizeSessionActor(providerPayload = {}) {
  const conversationId = clean(providerPayload.conversationId || providerPayload.conversation_id);
  if (!conversationId) throw new TypeError("ANTIGRAVITY_CONVERSATION_ID_REQUIRED");

  const parentConversationId = clean(providerPayload.parentConversationId || providerPayload.parent_conversation_id);
  const role = clean(providerPayload.role, 80);
  const profile = clean(providerPayload.profile, 120);
  const isRoot = rootCompatible({ parentConversationId, role, profile });

  const normalized = {
    provider: "antigravity",
    actorIdHash: hashId(conversationId),
    actorKind: isRoot ? "ROOT" : "CHILD",
  };
  if (!isRoot && parentConversationId) normalized.parentActorIdHash = hashId(parentConversationId);
  normalized.isRoot = isRoot;
  return normalized;
}
