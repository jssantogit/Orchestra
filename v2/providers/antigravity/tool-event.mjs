import { normalizeAntigravityActor } from "./actor.mjs";

const READ_TOOLS = new Set([
  "read", "read_file", "view_file", "grep", "grep_search", "glob", "find_by_name",
  "ls", "list_dir", "list_files", "search",
]);
const WRITE_TOOLS = new Set([
  "apply_patch", "write", "write_file", "write_to_file", "edit", "edit_file",
  "replace_file_content", "multi_replace_file_content", "create_file", "delete_file",
]);
const COMMAND_TOOLS = new Set(["bash", "shell", "exec", "run_command"]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function aliases(payload, keys) {
  return keys.filter((key) => Object.hasOwn(payload, key)).map((key) => payload[key]);
}

function toolCorrelationId(payload, calls) {
  const values = [
    ...aliases(payload, ["tool_call_id", "toolCallId"]),
    ...calls.filter((call) => Object.hasOwn(call, "id")).map((call) => call.id),
  ];
  if (values.length === 0) return null;
  if (values.some((value) => typeof value !== "string" || value.length === 0)
    || values.some((value) => value !== values[0])) {
    const error = new TypeError("Antigravity tool correlation aliases must identify one factual call");
    error.code = "ANTIGRAVITY_TOOL_CORRELATION_INVALID";
    throw error;
  }
  return values[0];
}

function eventTypeFor(payload) {
  const values = aliases(payload, ["eventType", "hook_event_name", "hookEventName"]);
  if (values.some((value) => typeof value !== "string") || values.some((value) => value !== values[0])) return "UNKNOWN";
  const raw = values[0] ?? "";
  if (!raw && (payload.toolCall || payload.tool_call)) return "TOOL_REQUEST";
  if (["PreToolUse", "ToolCall", "BeforeTool"].includes(raw)) return "TOOL_REQUEST";
  if (["PostToolUse", "ToolResult", "AfterTool"].includes(raw)) return "TOOL_RESULT";
  return "UNKNOWN";
}

function toolNameFor(payload, calls) {
  const values = [
    ...aliases(payload, ["tool_name", "toolName"]),
    ...calls.filter((call) => Object.hasOwn(call, "name")).map((call) => call.name),
  ];
  if (values.length === 0 || values.some((value) => typeof value !== "string")
    || values.some((value) => value !== values[0])) return "";
  return values[0].toLowerCase();
}

export function normalizeAntigravityToolEvent(providerPayload = {}) {
  if (!providerPayload || typeof providerPayload !== "object" || Array.isArray(providerPayload)) {
    normalizeAntigravityActor(providerPayload);
  }
  const actor = normalizeAntigravityActor(providerPayload);
  const calls = [
    record(providerPayload.toolCall),
    record(providerPayload.tool_call),
  ];
  const toolCallId = toolCorrelationId(providerPayload, calls);
  const eventType = eventTypeFor(providerPayload);
  const toolName = toolNameFor(providerPayload, calls);

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
