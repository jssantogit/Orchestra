import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { enforceExplorationToolBoundary } from "../dream/exploration-lab.mjs";

const BASELINE_GOVERNED_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "edit_file",
  "create_file",
  "invoke_subagent",
  "define_subagent",
  "run_command",
  "manage_task",
  "manage_subagents",
  "schedule",
  "send_message",
  "view_file",
  "grep_search",
  "find_by_name",
]);

const VALID_DECISIONS = new Set([
  "allow",
  "deny",
  "ask",
  "force_ask",
  "deny_unless_prior_grant",
]);

function deny(reason) {
  console.log(JSON.stringify({ decision: "deny", reason }));
}

function parseWorkspacePath(value) {
  if (!value || typeof value !== "string") return "";
  if (value.startsWith("file://")) {
    try { return fileURLToPath(value); } catch {}
  }
  return value;
}

function repoRoot(payload = {}) {
  const raw = payload.workspacePaths?.[0] || payload.workspaceUris?.[0] || null;
  if (raw) return resolve(parseWorkspacePath(raw));
  const cwd = process.cwd();
  if (basename(cwd) === ".agents") return resolve(cwd, "..");
  if (existsSync(resolve(cwd, ".agents"))) return cwd;
  if (existsSync(resolve(cwd, "../.agents"))) return resolve(cwd, "..");
  return cwd;
}

function main() {
  let rawInput = "";
  try {
    rawInput = readFileSync(0, "utf8");
  } catch {
    deny("EXPLORATION_INVALID_HOOK_PAYLOAD: PreToolUse payload could not be read.");
    return;
  }

  if (!rawInput.trim()) {
    deny("EXPLORATION_INVALID_HOOK_PAYLOAD: PreToolUse payload is empty.");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    deny("EXPLORATION_MALFORMED_HOOK_PAYLOAD: PreToolUse payload is not valid JSON.");
    return;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    deny("EXPLORATION_INVALID_HOOK_PAYLOAD: PreToolUse payload must be a JSON object.");
    return;
  }

  const toolCall = payload.toolCall && typeof payload.toolCall === "object" && !Array.isArray(payload.toolCall)
    ? payload.toolCall
    : (
      typeof payload.toolName === "string" && payload.toolName.trim()
        ? { name: payload.toolName, args: payload.toolArgs || payload.args || {} }
        : null
    );

  if (!toolCall || typeof toolCall.name !== "string" || !toolCall.name.trim()) {
    deny("EXPLORATION_INVALID_HOOK_PAYLOAD: PreToolUse payload is missing a valid tool name.");
    return;
  }

  const root = repoRoot(payload);
  const toolName = toolCall.name.trim();
  const toolArgs = toolCall.args && typeof toolCall.args === "object" && !Array.isArray(toolCall.args)
    ? toolCall.args
    : {};

  const boundary = enforceExplorationToolBoundary({
    repoRoot: root,
    toolName,
    toolArgs,
  });

  // This wrapper is installed only into a prepared sibling. If its session
  // marker disappeared or became unreadable, fail closed instead of silently
  // reverting to normal runtime authority.
  if (!boundary.active) {
    deny("EXPLORATION_SESSION_REQUIRED: isolated PreToolUse wrapper has no active exploration session.");
    return;
  }

  if (!boundary.allowed) {
    deny(boundary.reason || "EXPLORATION_BOUNDARY_DENIED");
    return;
  }

  // Allowed exploration tools must still pass the complete A-D governance
  // firewall. The wrapper never grants authority that pre-tool-enforce would
  // deny; it only adds the stricter Milestone E boundary in front.
  if (!BASELINE_GOVERNED_TOOLS.has(toolName)) {
    deny("EXPLORATION_TOOL_NOT_BASELINE_GOVERNED:" + toolName);
    return;
  }

  const baselineScript = resolve(dirname(fileURLToPath(import.meta.url)), "pre-tool-enforce.mjs");
  let rawResult;
  try {
    rawResult = execFileSync(process.execPath, [baselineScript], {
      input: rawInput,
      encoding: "utf8",
      cwd: process.cwd(),
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    deny("EXPLORATION_GOVERNANCE_DELEGATE_FAILED:" + String(error?.message || error));
    return;
  }

  let result;
  try {
    result = JSON.parse(rawResult);
  } catch {
    deny("EXPLORATION_GOVERNANCE_DELEGATE_INVALID_OUTPUT");
    return;
  }

  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.decision !== "string" ||
    !VALID_DECISIONS.has(result.decision)
  ) {
    deny("EXPLORATION_GOVERNANCE_DELEGATE_INVALID_DECISION");
    return;
  }

  console.log(JSON.stringify(result));
}

main();
