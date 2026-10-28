import { normalizeSessionActor } from "./session.mjs";

const READ_TOOLS = new Set(["read", "read_file", "view_file", "grep", "glob", "ls", "list_files", "search"]);
const WRITE_TOOLS = new Set(["apply_patch", "write", "write_file", "edit", "edit_file", "replace_file_content", "delete_file"]);
const COMMAND_TOOLS = new Set(["bash", "shell", "exec", "run_command"]);
// Exact observed native Codex tool names. Do not infer a safe operation from
// a prefix (future tools must be reviewed individually).
const WEB_RESEARCH_TOOLS = new Set(["webrun"]);
const USER_CLARIFICATION_TOOLS = new Set(["request_user_input_async"]);
const AGENT_MESSAGE_TOOLS = new Set(["send_message", "collaborationsend_message"]);

const SPAWN_TOOLS = new Set([
  "spawn_agent", "collaborationspawn_agent", "multi_agent_v1spawn_agent",
  "multi_agent_v1.spawn_agent",
]);
const AGENT_CONTROL_TOOLS = new Set([
  "collaborationwait_agent",
  "collaborationfollowup_task", "collaborationlist_agents",
  "collaborationinterrupt_agent",
  "multi_agent_v1wait_agent", "multi_agent_v1send_input",
  "multi_agent_v1close_agent", "multi_agent_v1resume_agent",
  "multi_agent_v1.wait_agent", "multi_agent_v1.send_input",
  "multi_agent_v1.close_agent", "multi_agent_v1.resume_agent",
]);


// Only explicitly known native Codex agent tool names are control-plane tools.
// Future/unrecognized collaboration names remain fail-closed.
export function isCodexNativeAgentTool(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  return SPAWN_TOOLS.has(normalized) || AGENT_CONTROL_TOOLS.has(normalized) || AGENT_MESSAGE_TOOLS.has(normalized);
}

export function isCodexNativeControlTool(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  return isCodexNativeAgentTool(normalized)
    || WEB_RESEARCH_TOOLS.has(normalized)
    || USER_CLARIFICATION_TOOLS.has(normalized);
}

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function eventTypeFor(raw) {
  const event = clean(raw, 120);
  if (event === "PreToolUse") return "TOOL_REQUEST";
  if (event === "PostToolUse") return "TOOL_RESULT";
  return "UNKNOWN";
}

function targetFor(toolName, input) {
  if (toolName === "apply_patch") return "workspace";
  return clean(input?.file_path || input?.filePath || input?.path || input?.target, 500) || null;
}

export function normalizeToolEvent(providerPayload = {}) {
  const actor = normalizeSessionActor(providerPayload);
  const rawEvent = clean(providerPayload.hook_event_name || providerPayload.hookEventName, 120);
  const eventType = eventTypeFor(rawEvent);
  const toolName = clean(providerPayload.tool_name || providerPayload.toolName, 120).toLowerCase();
  const input = providerPayload.tool_input || providerPayload.toolInput || {};
  const toolCallId = clean(providerPayload.tool_call_id || providerPayload.toolCallId || providerPayload.tool_call?.id, 300);

  let operation = "UNKNOWN";
  let sideEffectClass = "UNKNOWN";
  let target = null;
  if (eventType !== "UNKNOWN") {
    if (READ_TOOLS.has(toolName)) {
      operation = "READ";
      sideEffectClass = "READ_ONLY";
      target = targetFor(toolName, input);
    } else if (WRITE_TOOLS.has(toolName)) {
      operation = "WRITE";
      sideEffectClass = "WORKSPACE_MUTATION";
      target = targetFor(toolName, input) || "workspace";
    } else if (COMMAND_TOOLS.has(toolName)) {
      operation = "COMMAND";
      sideEffectClass = "UNKNOWN";
      target = "shell";
    } else if (SPAWN_TOOLS.has(toolName)) {
      // Delegation is a CONTROL-plane request, not direct workspace mutation.
      // The PreToolUse authority gate validates parent actor and installed role.
      operation = "DELEGATE";
      sideEffectClass = "DELEGATION";
      target = clean(input?.agent_type || input?.agentType, 120) || null;
    } else if (AGENT_CONTROL_TOOLS.has(toolName)) {
      operation = "AGENT_CONTROL";
      sideEffectClass = "DELEGATION";
      target = clean(input?.target || input?.agent_id || input?.agentId, 120) || null;
    } else if (AGENT_MESSAGE_TOOLS.has(toolName)) {
      operation = "AGENT_MESSAGE";
      sideEffectClass = "DELEGATION";
      target = clean(input?.target || input?.recipient || input?.to, 120) || null;
    } else if (WEB_RESEARCH_TOOLS.has(toolName)) {
      operation = "WEB_RESEARCH";
      sideEffectClass = "NETWORK_READ";
      target = "web";
    } else if (USER_CLARIFICATION_TOOLS.has(toolName)) {
      operation = "USER_CLARIFICATION";
      sideEffectClass = "HUMAN_INTERACTION";
      target = "user";
    }
  }

  const factualIds = { actorIdHash: actor.actorIdHash };
  if (actor.parentActorIdHash) factualIds.parentActorIdHash = actor.parentActorIdHash;
  if (toolCallId) factualIds.toolCallId = toolCallId;

  const normalized = { eventType, operation, target, sideEffectClass, factualIds };
  if (toolCallId) normalized.rawRef = `codex:${rawEvent || "tool"}:${toolCallId}`;
  return normalized;
}
