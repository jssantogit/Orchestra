import { normalizeCodexActor } from "./actor.mjs";

const READ_TOOLS = new Set(["read", "read_file", "view_file", "grep", "glob", "ls", "list_files", "search"]);
const WRITE_TOOLS = new Set(["apply_patch", "write", "write_file", "edit", "edit_file", "replace_file_content", "delete_file"]);
const COMMAND_TOOLS = new Set(["bash", "shell", "exec", "run_command"]);

function value(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function factualToolCallId(payload) {
  const hasId = Object.hasOwn(payload, "tool_call_id")
    || Object.hasOwn(payload, "toolCallId")
    || payload.tool_call && Object.hasOwn(payload.tool_call, "id");
  if (!hasId) return null;
  const id = payload.tool_call_id ?? payload.toolCallId ?? payload.tool_call?.id;
  if (typeof id !== "string" || !id.trim()) {
    const error = new TypeError("Codex tool_call_id must be a non-empty string");
    error.code = "CODEX_TOOL_CALL_ID_INVALID";
    throw error;
  }
  return id;
}

export function normalizeCodexToolEvent(payload = {}) {
  const actor = normalizeCodexActor(payload);
  const hookEvent = value(payload.hook_event_name, 120);
  const eventType = hookEvent === "PreToolUse" ? "TOOL_REQUEST"
    : hookEvent === "PostToolUse" ? "TOOL_RESULT" : "UNKNOWN";
  const toolName = value(payload.tool_name, 120).toLowerCase();
  const toolCallId = factualToolCallId(payload);
  let operation = "UNKNOWN";
  let sideEffectClass = "UNKNOWN";
  if (eventType !== "UNKNOWN") {
    if (READ_TOOLS.has(toolName)) [operation, sideEffectClass] = ["READ", "READ_ONLY"];
    else if (WRITE_TOOLS.has(toolName)) [operation, sideEffectClass] = ["WRITE", "WORKSPACE_MUTATION"];
    else if (COMMAND_TOOLS.has(toolName)) [operation, sideEffectClass] = ["COMMAND", "UNKNOWN"];
  }
  return Object.freeze({
    eventType,
    operation,
    sideEffectClass,
    factualIds: Object.freeze({
      actorIdHash: actor.actorIdHash,
      ...(actor.parentActorIdHash ? { parentActorIdHash: actor.parentActorIdHash } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    }),
  });
}
