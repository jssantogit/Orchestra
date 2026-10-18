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

function hookEventFromInput(input) {
  try {
    const hookEventName = JSON.parse(input)?.hook_event_name ?? null;
    return ["SessionStart", "PreToolUse", "PostToolUse"].includes(hookEventName)
      ? hookEventName
      : null;
  } catch {
    return null;
  }
}

function denyWire(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function failClosed(input) {
  const hookEventName = hookEventFromInput(input);
  const payload = hookEventName === "PreToolUse" ? denyWire(GLOBAL_UNAVAILABLE) : {};
  process.stdout.write(JSON.stringify(payload) + "\\n");
  // Codex 0.159.x consumes a semantic PreToolUse deny only from a successful hook.
  // Other transport failures remain non-zero diagnostics and expose no Orchestra-internal fields.
  process.exitCode = hookEventName === "PreToolUse" ? 0 : 1;
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
      if (hookEventName === "PreToolUse") {
        if (output.permissionDecision !== (decoded.ok ? "allow" : "deny")) return false;
        if (!decoded.ok
          && (typeof output.permissionDecisionReason !== "string" || !output.permissionDecisionReason.trim())) return false;
      }
      if (hookEventName === "SessionStart" && decoded.ok && typeof output.additionalContext !== "string") return false;
    } else if (hookEventName === "PreToolUse" || (hookEventName === "SessionStart" && decoded.ok)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function projectProviderWire(value, hookEventName) {
  const decoded = JSON.parse(value);
  const output = decoded.hookSpecificOutput;

  if (hookEventName === "PreToolUse") {
    if (output.permissionDecision === "deny") {
      return denyWire(output.permissionDecisionReason);
    }
    // Codex 0.159.x does not support an explicit "allow" decision without updatedInput.
    // A valid empty PreToolUse decision means continue with the original tool input.
    return { hookSpecificOutput: { hookEventName: "PreToolUse" } };
  }

  if (hookEventName === "SessionStart" && output) {
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: output.additionalContext,
      },
    };
  }

  // PostToolUse currently has no provider-facing control effect. Internal operation facts
  // remain in the global control plane and must not leak into Codex's closed wire schema.
  return {};
}

function providerExitCode(value, hookEventName, launcherCode) {
  if (hookEventName !== "PreToolUse") return launcherCode;
  try {
    const decision = JSON.parse(value)?.hookSpecificOutput?.permissionDecision;
    if (decision === "allow" || decision === "deny") return 0;
  } catch {
    // parseProtocolResponse already guards this path; retain launcher status defensively.
  }
  return launcherCode;
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
const hookEventName = hookEventFromInput(input);
if (result.launchError || result.code === null || !parseProtocolResponse(result.stdout, hookEventName)) {
  failClosed(input);
} else {
  process.stdout.write(JSON.stringify(projectProviderWire(result.stdout, hookEventName)) + "\\n");
  process.exitCode = providerExitCode(result.stdout, hookEventName, result.code);
}
`;
}
