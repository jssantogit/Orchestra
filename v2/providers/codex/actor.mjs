import { createHash } from "node:crypto";

function hashId(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function factualId(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function identityError() {
  const error = new TypeError("Codex hook payload must include a factual session_id");
  error.code = "CODEX_PROVIDER_IDENTITY_INVALID";
  return error;
}

export function normalizeCodexActor(payload = {}, _env = {}) {
  const sessionId = factualId(payload.session_id);
  if (!sessionId) throw identityError();

  const hasAgentId = Object.hasOwn(payload, "agent_id");
  const agentId = factualId(payload.agent_id);
  if (hasAgentId && !agentId) throw identityError();
  if (agentId) {
    return Object.freeze({
      provider: "codex",
      actorKind: "CHILD",
      actorIdHash: hashId(agentId),
      parentActorIdHash: hashId(sessionId),
      isRoot: false,
    });
  }

  return Object.freeze({
    provider: "codex",
    actorKind: "ROOT",
    actorIdHash: hashId(sessionId),
    isRoot: true,
  });
}
