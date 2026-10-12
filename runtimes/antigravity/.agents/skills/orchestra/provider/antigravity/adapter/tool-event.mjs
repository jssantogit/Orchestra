import { normalizeSessionActor } from "./session.mjs";

const READ_TOOLS = new Set(["view_file", "read_file", "grep_search", "grep", "find_by_name", "list_dir", "list_files", "search"]);
const WRITE_TOOLS = new Set(["replace_file_content", "multi_replace_file_content", "write_file", "write_to_file", "edit_file", "create_file", "apply_patch", "delete_file"]);
const COMMAND_TOOLS = new Set(["run_command", "shell", "exec"]);
const CONTROL_TOOLS = new Set(["invoke_subagent", "define_subagent", "manage_subagents", "manage_task", "schedule", "send_message"]);

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function eventTypeFor(payload) {
  const raw = clean(payload.eventType || payload.hook_event_name || payload.hookEventName, 120);
  if (!raw && payload.toolCall) return "TOOL_REQUEST";
  if (["PreToolUse", "ToolCall", "BeforeTool"].includes(raw)) return "TOOL_REQUEST";
  if (["PostToolUse", "ToolResult", "AfterTool"].includes(raw)) return "TOOL_RESULT";
  return "UNKNOWN";
}

function targetFor(args) {
  return clean(args?.path || args?.file_path || args?.filePath || args?.target, 500) || null;
}

export function normalizeToolEvent(providerPayload = {}) {
  const actor = normalizeSessionActor(providerPayload);
  const eventType = eventTypeFor(providerPayload);
  const toolCall = providerPayload.toolCall || providerPayload.tool_call || {};
  const toolName = clean(toolCall.name || providerPayload.tool_name || providerPayload.toolName, 120).toLowerCase();
  const args = toolCall.args || providerPayload.tool_input || providerPayload.toolInput || {};
  const toolCallId = clean(toolCall.id || providerPayload.toolCallId || providerPayload.tool_call_id, 300);

  let operation = "UNKNOWN";
  let sideEffectClass = "UNKNOWN";
  let target = null;
  if (eventType !== "UNKNOWN") {
    if (READ_TOOLS.has(toolName)) {
      operation = "READ";
      sideEffectClass = "READ_ONLY";
      target = targetFor(args);
    } else if (WRITE_TOOLS.has(toolName)) {
      operation = "WRITE";
      sideEffectClass = "WORKSPACE_MUTATION";
      target = targetFor(args) || "workspace";
    } else if (COMMAND_TOOLS.has(toolName)) {
      operation = "COMMAND";
      sideEffectClass = "UNKNOWN";
      target = "shell";
    } else if (CONTROL_TOOLS.has(toolName)) {
      operation = toolName === "invoke_subagent" ? "DELEGATE" : (toolName === "send_message" ? "MESSAGE" : "CONTROL");
      sideEffectClass = "CONTROL_PLANE";
      target = null;
    }
  }

  const factualIds = { actorIdHash: actor.actorIdHash };
  if (actor.parentActorIdHash) factualIds.parentActorIdHash = actor.parentActorIdHash;
  if (toolCallId) factualIds.toolCallId = toolCallId;

  const normalized = { eventType, operation, target, sideEffectClass, factualIds };
  if (toolCallId) normalized.rawRef = `antigravity:tool:${toolCallId}`;
  return normalized;
}
