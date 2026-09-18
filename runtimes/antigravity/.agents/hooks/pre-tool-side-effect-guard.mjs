import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { authorizeToolCapability } from "../skills/orchestra/trust-boundary.mjs";
import {
  isCanaryExternalSideEffect,
  rollbackSelectedCanaryTask,
} from "../dream/canary-mode.mjs";

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function workspaceRoot(payload = {}) {
  const candidates = [
    ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []),
    payload.workspacePath,
    payload.cwd,
    process.cwd(),
  ].filter((value) => typeof value === "string" && value.trim());
  return resolve(candidates[0] || process.cwd());
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return { exists: false, ok: true, value: null };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { exists: true, ok: false, reason: "INVALID_OBJECT_SHAPE" };
    }
    return { exists: true, ok: true, value };
  } catch {
    return { exists: true, ok: false, reason: "MALFORMED_JSON" };
  }
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    console.log(JSON.stringify({
      decision: "deny",
      reason: "INVALID_HOOK_PAYLOAD: Side-effect boundary received no payload.",
    }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({
      decision: "deny",
      reason: "MALFORMED_HOOK_PAYLOAD: Side-effect boundary payload is not valid JSON.",
    }));
    return;
  }

  const toolCall = payload?.toolCall && typeof payload.toolCall === "object"
    ? payload.toolCall
    : (typeof payload?.toolName === "string"
      ? { name: payload.toolName, args: payload.toolArgs || payload.args || {} }
      : null);
  const toolName = typeof toolCall?.name === "string" ? toolCall.name.trim() : "";
  const toolArgs = toolCall?.args && typeof toolCall.args === "object" && !Array.isArray(toolCall.args)
    ? toolCall.args
    : {};
  if (!toolName) {
    console.log(JSON.stringify({
      decision: "deny",
      reason: "INVALID_HOOK_PAYLOAD: Side-effect boundary requires a tool name.",
    }));
    return;
  }

  const repoRoot = workspaceRoot(payload);
  const statePath = resolve(repoRoot, ".agents/state/active-state.json");
  const contractPath = resolve(repoRoot, ".agents/state/active-contract.json");
  const stateLoad = readJsonIfPresent(statePath);
  const contractLoad = readJsonIfPresent(contractPath);
  if (!stateLoad.ok || !contractLoad.ok) {
    console.log(JSON.stringify({
      decision: "deny",
      reason: "GOVERNANCE_STATE_INVALID: Side-effect authority could not be reconstructed.",
    }));
    return;
  }

  const activeState = stateLoad.value || {};
  const activeContract = contractLoad.value
    || (activeState.scopeContract && typeof activeState.scopeContract === "object" && !Array.isArray(activeState.scopeContract)
      ? activeState.scopeContract
      : {});

  const taskId =
    payload.taskId
    || payload.taskIdentifier
    || activeState.taskId
    || activeState.taskKey
    || null;

  if (isCanaryExternalSideEffect({ toolName, toolArgs })) {
    const rollback = rollbackSelectedCanaryTask({
      repoRoot,
      taskId,
      trigger: "EXTERNAL_SIDE_EFFECT_ATTEMPT",
      details: { tool_name: toolName },
    });
    if (rollback.rolled_back) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "CANARY_ROLLBACK: External side effects are ineligible during Canary.",
      }));
      return;
    }
  }

  const auth = authorizeToolCapability({
    toolName,
    toolArgs,
    activeState,
    activeContract,
  });

  if (!auth.allowed) {
    if (stateLoad.exists) {
      activeState.lastCapabilityDecision = {
        toolName,
        capability: auth.capability,
        allowed: false,
        explicit: false,
        authority: null,
        observedAt: new Date().toISOString(),
      };
      try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf8"); } catch {}
    }
    console.log(JSON.stringify({
      decision: "deny",
      reason: `SIDE_EFFECT_CAPABILITY_DENIED: ${auth.capability} requires explicit factual authority in the Scope Contract.`,
    }));
    return;
  }

  console.log(JSON.stringify({ decision: "allow" }));
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
