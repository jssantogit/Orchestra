import { createHash } from "node:crypto";

function clean(value, max = 300) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function hashId(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeSessionActor(providerPayload = {}) {
  const sessionId = clean(providerPayload.session_id || providerPayload.sessionId);
  if (!sessionId) throw new TypeError("CODEX_SESSION_ID_REQUIRED");

  const childId = clean(providerPayload.agent_id || providerPayload.agentId);
  if (childId) {
    return {
      provider: "codex",
      actorIdHash: hashId(childId),
      actorKind: "CHILD",
      parentActorIdHash: hashId(sessionId),
      isRoot: false,
    };
  }

  return {
    provider: "codex",
    actorIdHash: hashId(sessionId),
    actorKind: "ROOT",
    isRoot: true,
  };
}
