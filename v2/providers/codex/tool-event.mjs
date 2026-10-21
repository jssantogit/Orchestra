import { normalizeCodexActor } from "./actor.mjs";

const READ_TOOLS = new Set(["read", "read_file", "view_file", "grep", "glob", "ls", "list_files", "search"]);
const WRITE_TOOLS = new Set(["apply_patch", "write", "write_file", "edit", "edit_file", "replace_file_content", "delete_file"]);
const COMMAND_TOOLS = new Set(["bash", "shell", "exec", "run_command"]);

function value(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

// Native apply_patch uses tool_input.command; freeform/older transports may
// carry the patch itself. Never choose one of contradictory supplied aliases.
export function codexPatchText(payload = {}) {
  const input = payload.tool_input;
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const values = ['command', 'patch', 'input'].filter(key => Object.hasOwn(input,key)).map(key => input[key]);
  if (values.length === 0 || values.some(text => typeof text !== 'string' || !text)
    || values.some(text => text !== values[0])) return null;
  return values[0];
}

function factualToolCallId(payload) {
  const values = [
    ...(Object.hasOwn(payload, "tool_use_id") ? [payload.tool_use_id] : []),
    ...(Object.hasOwn(payload, "tool_call_id") ? [payload.tool_call_id] : []),
    ...(Object.hasOwn(payload, "toolCallId") ? [payload.toolCallId] : []),
    ...(payload.tool_call && Object.hasOwn(payload.tool_call, "id") ? [payload.tool_call.id] : []),
  ];
  if (values.length === 0) return null;
  if (values.some((id) => typeof id !== "string" || !id.trim())
    || values.some((id) => id !== values[0])) {
    const error = new TypeError("Codex tool correlation aliases must identify one factual call");
    error.code = "CODEX_TOOL_CORRELATION_INVALID";
    throw error;
  }
  return values[0];
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
