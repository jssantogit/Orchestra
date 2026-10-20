const GLOBAL_UNAVAILABLE = "ORCHESTRA_V2_GLOBAL_UNAVAILABLE";
const GLOBAL_UNAVAILABLE_MESSAGE = "The Orchestra v2 global launcher could not process this Antigravity hook. Repair the global Orchestra installation, then retry.";

export function renderAntigravityV2Shim({ launcherPath, nodePath = process.execPath, orchestraHome = null } = {}) {
  if (typeof launcherPath !== "string" || launcherPath.trim() === "") {
    throw new TypeError("launcherPath is required");
  }
  if (typeof nodePath !== "string" || nodePath.trim() === "") {
    throw new TypeError("nodePath is required");
  }
  if (orchestraHome !== null && (typeof orchestraHome !== "string" || orchestraHome.trim() === "")) {
    throw new TypeError("orchestraHome must be a non-empty path when provided");
  }

  return `#!/usr/bin/env node
import { spawn } from "node:child_process";

const GLOBAL_LAUNCHER = ${JSON.stringify(launcherPath)};
const NODE_EXECUTABLE = ${JSON.stringify(nodePath)};
const GLOBAL_ORCHESTRA_HOME = ${JSON.stringify(orchestraHome)};
const GLOBAL_UNAVAILABLE = ${JSON.stringify(GLOBAL_UNAVAILABLE)};
const GLOBAL_UNAVAILABLE_MESSAGE = ${JSON.stringify(GLOBAL_UNAVAILABLE_MESSAGE)};
const CONFIGURED_EVENT = process.argv.length === 4 && process.argv[2] === "--event"
  && ["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse"].includes(process.argv[3])
  ? process.argv[3] : null;

function transportInput(input) {
  if (!CONFIGURED_EVENT) return input;
  const payload = JSON.parse(input);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Invalid hook input");
  const supplied = ["eventType", "hook_event_name", "hookEventName"]
    .filter((key) => Object.hasOwn(payload, key));
  if (supplied.some((key) => payload[key] !== CONFIGURED_EVENT)) throw new TypeError("Conflicting hook event");
  return JSON.stringify({ ...payload, hookEventName: CONFIGURED_EVENT });
}

function requestedEvent(input) {
  try {
    const payload = JSON.parse(input);
    const names = ["eventType", "hook_event_name", "hookEventName"]
      .filter((key) => Object.hasOwn(payload ?? {}, key))
      .map((key) => payload[key]);
    if (names.some((name) => typeof name !== "string")
      || (names.length > 0 && names.some((name) => name !== names[0]))) return null;
    const raw = names[0] ?? "";
    if (raw === "SessionStart" || raw === "PreInvocation") return raw;
    if (["PreToolUse", "ToolCall", "BeforeTool"].includes(raw)) return "PreToolUse";
    if (["PostToolUse", "ToolResult", "AfterTool"].includes(raw)) return "PostToolUse";
    if (!raw && (payload?.toolCall || payload?.tool_call)) return "PreToolUse";
    return raw || null;
  } catch {
    return null;
  }
}

function failClosed(input) {
  const eventName = CONFIGURED_EVENT ?? requestedEvent(input);
  const response = providerResponse({ ok: false, reason: GLOBAL_UNAVAILABLE }, eventName);
  process.stdout.write(JSON.stringify(response) + "\\n");
  process.stderr.write(GLOBAL_UNAVAILABLE_MESSAGE + "\\n");
  process.exitCode = eventName === "PreToolUse" ? 0 : 1;
}

function providerResponse(response, eventName) {
  if (eventName === "SessionStart" || eventName === "PreInvocation") return { injectSteps: [] };
  if (eventName === "PreToolUse") {
    return response.ok ? { decision: "allow" } : { decision: "deny", reason: response.reason };
  }
  return {};
}

function isProtocolResponse(value, eventName, exitCode) {
  if (!value.trim()) return false;
  try {
    const response = JSON.parse(value);
    if (response === null || typeof response !== "object" || Array.isArray(response)) return false;
    if (typeof response.ok !== "boolean") return false;
    if (!["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse"].includes(eventName)) return false;
    if (response.ok) {
      if (response.reason !== null && (typeof response.reason !== "string" || !response.reason.trim())) return false;
    } else if (typeof response.reason !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(response.reason)) {
      return false;
    }
    if (response.ok !== (exitCode === 0)) return false;

    const output = response.hookSpecificOutput;
    if (output !== undefined) {
      if (!output || typeof output !== "object" || Array.isArray(output)) return false;
      const expectedOutputEvent = eventName === "ToolCall" || eventName === "BeforeTool" ? "PreToolUse"
        : eventName === "ToolResult" || eventName === "AfterTool" ? "PostToolUse"
          : eventName;
      if (expectedOutputEvent && output.hookEventName !== expectedOutputEvent) return false;
      if (expectedOutputEvent === "PreToolUse"
        && output.permissionDecision !== (response.ok ? "allow" : "deny")) return false;
      if ((expectedOutputEvent === "SessionStart" || expectedOutputEvent === "PreInvocation")
        && response.ok && typeof output.additionalContext !== "string") return false;
    } else if (eventName === "PreToolUse" || eventName === "ToolCall" || eventName === "BeforeTool"
      || ((eventName === "SessionStart" || eventName === "PreInvocation") && response.ok)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function invokeGlobalLauncher(input) {
  return new Promise((resolve) => {
    let stdout = "";
    let launchError = false;
    let child;
    try {
      child = spawn(NODE_EXECUTABLE, [GLOBAL_LAUNCHER, "provider", "antigravity", "hook"], {
        cwd: process.cwd(),
        env: GLOBAL_ORCHESTRA_HOME
          ? { ...process.env, ORCHESTRA_HOME: GLOBAL_ORCHESTRA_HOME }
          : process.env,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve({ code: null, stdout, launchError: true });
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => { launchError = true; });
    child.stdin.on("error", () => { launchError = true; });
    child.on("close", (code) => resolve({ code, stdout, launchError }));
    child.stdin.end(input);
  });
}

let input = "";
for await (const chunk of process.stdin) input += chunk.toString();
try {
  input = transportInput(input);
} catch {
  failClosed(input);
  process.exit(process.exitCode);
}
const result = await invokeGlobalLauncher(input);
const eventName = requestedEvent(input);
if (result.launchError || result.code === null || !isProtocolResponse(result.stdout, eventName, result.code)) {
  failClosed(input);
} else {
  const response = JSON.parse(result.stdout);
  process.stdout.write(JSON.stringify(providerResponse(response, eventName)) + "\\n");
  process.exitCode = eventName === "PreToolUse" ? 0 : result.code;
}
`;
}
