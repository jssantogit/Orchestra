import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const QUIESCENT_STATES = new Set(["DONE", "BLOCKED", "HUMAN_GATE"]);
const ACTIVE_STATES = new Set([
  "CLASSIFIED",
  "DIRECT_ACTION",
  "PLANNED",
  "DELEGATED",
  "EXECUTING",
  "EVIDENCE_READY",
  "CI_WAIT",
  "ACCEPTANCE",
  "INTEGRATING",
  "CRITICAL_REVIEW",
]);

export async function checkAntigravityProjectRuntimeQuiescence(targetDir) {
  const statePath = join(resolve(targetDir), ".agents", "state", "active-state.json");
  let value;
  try {
    value = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { safe: true, reason: "NO_ACTIVE_STATE", activeState: null };
    }
    if (error instanceof SyntaxError) {
      return { safe: false, reason: "ACTIVE_STATE_UNREADABLE", activeState: null };
    }
    throw error;
  }

  const state = String(value?.state || "").trim().toUpperCase();
  if (!state) return { safe: false, reason: "ACTIVE_STATE_UNKNOWN", activeState: value };
  if (QUIESCENT_STATES.has(state)) return { safe: true, reason: `QUIESCENT_${state}`, activeState: value };
  if (ACTIVE_STATES.has(state)) return { safe: false, reason: `RUNTIME_ACTIVE_${state}`, activeState: value };
  return { safe: false, reason: `UNRECOGNIZED_STATE_${state}`, activeState: value };
}

export const antigravityProjectRuntimeAdapter = Object.freeze({
  checkQuiescence: checkAntigravityProjectRuntimeQuiescence,
});
