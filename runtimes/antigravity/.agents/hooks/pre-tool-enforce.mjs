import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authorizeToolCapability } from "../skills/orchestra/trust-boundary.mjs";

export {
  startPendingInvestigationRequirement,
  classifyOrchestratorHandoffControlCommand,
  isValidAgentName,
} from "./pre-tool-enforce-legacy.mjs";

const legacyHook = resolve(dirname(fileURLToPath(import.meta.url)), "pre-tool-enforce-legacy.mjs");

function readJson(path, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function resolveWorkspaceRoot(payload = {}) {
  const raw = (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0])
    || (Array.isArray(payload.workspaceUris) && payload.workspaceUris[0])
    || null;
  if (typeof raw !== "string" || !raw.trim()) return process.cwd();
  const value = raw.trim();
  try {
    if (value.startsWith("file://")) return fileURLToPath(value);
  } catch {}
  return resolve(value);
}

function normalizeToolCall(payload = {}) {
  if (payload.toolCall && typeof payload.toolCall === "object" && !Array.isArray(payload.toolCall)) {
    return payload.toolCall;
  }
  if (typeof payload.toolName === "string" && payload.toolName.trim()) {
    return { name: payload.toolName, args: payload.toolArgs || payload.args || {} };
  }
  return null;
}

function enforceGlobalSideEffectBoundary(input) {
  let payload;
  try { payload = JSON.parse(input); } catch { return false; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  const toolCall = normalizeToolCall(payload);
  if (!toolCall || typeof toolCall.name !== "string" || !toolCall.name.trim()) return false;

  const repoRoot = resolveWorkspaceRoot(payload);
  const activeState = readJson(resolve(repoRoot, ".agents/state/active-state.json"), {});
  const activeContract = readJson(
    resolve(repoRoot, ".agents/state/active-contract.json"),
    activeState.scopeContract && typeof activeState.scopeContract === "object" ? activeState.scopeContract : {},
  );
  const toolArgs = toolCall.args && typeof toolCall.args === "object" && !Array.isArray(toolCall.args)
    ? toolCall.args
    : {};
  const sideEffectAuth = authorizeToolCapability({
    toolName: toolCall.name.trim(),
    toolArgs,
    activeState,
    activeContract,
  });
  if (sideEffectAuth.allowed) return false;

  process.stdout.write(`${JSON.stringify({
    decision: "deny",
    reason: `SIDE_EFFECT_CAPABILITY_DENIED: ${sideEffectAuth.capability} requires explicit factual authority in the Scope Contract.`,
  })}\n`);
  return true;
}

function main() {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch {}

  // The public entrypoint owns the global side-effect boundary. The compatibility
  // engine may apply the same defense again, but it cannot be the sole authority.
  if (enforceGlobalSideEffectBoundary(input)) return;

  const result = spawnSync(process.execPath, [legacyHook], {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.status ?? (result.error ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
