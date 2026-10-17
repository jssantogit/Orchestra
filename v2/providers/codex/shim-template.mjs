const GLOBAL_UNAVAILABLE = "ORCHESTRA_V2_GLOBAL_UNAVAILABLE";

export function renderCodexV2Shim({ launcherPath, nodePath = process.execPath, orchestraHome = null } = {}) {
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

function failClosed(input) {
  let hookEventName = null;
  try {
    const request = JSON.parse(input);
    if (["SessionStart", "PreToolUse", "PostToolUse"].includes(request?.hook_event_name)) {
      hookEventName = request.hook_event_name;
    }
  } catch {
    // Preserve the transport boundary: an unparseable request cannot select a hook response shape.
  }
  const payload = {
    ok: false,
    reason: GLOBAL_UNAVAILABLE,
  };
  if (hookEventName) {
    payload.hookSpecificOutput = { hookEventName };
    if (hookEventName === "PreToolUse") {
      payload.hookSpecificOutput.permissionDecision = "deny";
      payload.hookSpecificOutput.permissionDecisionReason = GLOBAL_UNAVAILABLE;
    }
    if (hookEventName === "SessionStart") {
      payload.hookSpecificOutput.additionalContext = GLOBAL_UNAVAILABLE;
    }
  }
  process.stdout.write(JSON.stringify(payload) + "\\n");
  process.exitCode = 1;
}

function parseProtocolResponse(value, hookEventName) {
  if (!value.trim()) return false;
  try {
    const decoded = JSON.parse(value);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return false;
    if (typeof decoded.ok !== "boolean") return false;
    if (decoded.ok) {
      if (decoded.reason !== null && (typeof decoded.reason !== "string" || !decoded.reason.trim())) return false;
    } else if (typeof decoded.reason !== "string" || !decoded.reason.trim()) {
      return false;
    }
    const output = decoded.hookSpecificOutput;
    if (output !== undefined) {
      if (!output || typeof output !== "object" || Array.isArray(output)) return false;
      if (output.hookEventName !== hookEventName) return false;
      if (hookEventName === "PreToolUse"
        && output.permissionDecision !== (decoded.ok ? "allow" : "deny")) return false;
      if (hookEventName === "SessionStart" && decoded.ok && typeof output.additionalContext !== "string") return false;
    } else if (hookEventName === "PreToolUse" || (hookEventName === "SessionStart" && decoded.ok)) {
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
    const child = spawn(NODE_EXECUTABLE, [GLOBAL_LAUNCHER, "provider", "codex", "hook"], {
      cwd: process.cwd(),
      env: GLOBAL_ORCHESTRA_HOME
        ? { ...process.env, ORCHESTRA_HOME: GLOBAL_ORCHESTRA_HOME }
        : process.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
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
const result = await invokeGlobalLauncher(input);
let hookEventName = null;
try {
  hookEventName = JSON.parse(input)?.hook_event_name ?? null;
} catch {
  // The global handler remains the authority for invalid provider payloads.
}
if (result.launchError || result.code === null || !parseProtocolResponse(result.stdout, hookEventName)) {
  failClosed(input);
} else {
  process.stdout.write(result.stdout);
  process.exitCode = result.code;
}
`;
}
