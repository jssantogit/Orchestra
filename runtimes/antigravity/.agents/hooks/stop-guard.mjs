import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  STOP_DECISIONS,
  evaluateStopDecision,
} from "../skills/orchestra/core/acceptance/stop-decision.mjs";
import { readWorkLease } from "../skills/orchestra/core/leases/work-lease-store.mjs";

export {
  parseReviewerVerdictText,
  extractReviewerVerdict,
  syncChildEvidence,
} from "./stop-guard-legacy.mjs";
export { STOP_DECISIONS, evaluateStopDecision };

const legacyHook = resolve(dirname(fileURLToPath(import.meta.url)), "stop-guard-legacy.mjs");

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function parseWorkspacePath(value) {
  if (typeof value !== "string") return "";
  if (value.startsWith("file://")) {
    try { return fileURLToPath(value); } catch { return value.replace(/^file:\/\/\/?/, ""); }
  }
  return value;
}

function repoRootFrom(payload = {}) {
  const raw = (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0])
    || (Array.isArray(payload.workspaceUris) && payload.workspaceUris[0])
    || payload.cwd
    || null;
  if (raw) return resolve(parseWorkspacePath(raw));
  const cwd = process.cwd();
  if (basename(cwd) === ".agents") return resolve(cwd, "..");
  if (existsSync(resolve(cwd, ".agents"))) return cwd;
  if (existsSync(resolve(cwd, "../.agents"))) return resolve(cwd, "..");
  return cwd;
}

function canonicalContext(activeState = {}) {
  const packet = activeState.implementationPacket || activeState.implementation_packet || activeState.directWork?.implementationPacket || null;
  const candidate = activeState.candidate && typeof activeState.candidate === "object" ? activeState.candidate : null;
  const evidence = Array.isArray(activeState.evidenceLedger)
    ? activeState.evidenceLedger
    : (Array.isArray(activeState.evidence) ? activeState.evidence : null);
  if (packet?.schema !== "orchestra.implementation-packet.v1") return null;
  if (candidate?.schema !== "orchestra.candidate.v1") return null;
  if (!evidence || evidence.some((item) => item?.schema !== "orchestra.evidence.v1")) return null;
  return {
    packet,
    candidate,
    evidence,
    audit: activeState.audit || activeState.quickAudit || null,
    workflow: {
      mode: "DIRECT_WORK",
      auditRequired: activeState.auditRequired !== false,
      humanGate: activeState.humanGate === true || activeState.state === "HUMAN_GATE",
      blocked: activeState.state === "BLOCKED",
      returnToControl: activeState.returnToControl === true,
      unresolvedDiagnosis: activeState.unresolvedDiagnosis === true,
      reason: activeState.stopReason || null,
    },
  };
}

export function evaluateCanonicalStopState({ activeState = {}, lease = null } = {}) {
  const context = canonicalContext(activeState);
  if (!context) return null;
  const result = evaluateStopDecision({ ...context, lease });
  const stop = [STOP_DECISIONS.ACCEPT, STOP_DECISIONS.HUMAN_GATE, STOP_DECISIONS.BLOCKED].includes(result.decision);
  return Object.freeze({
    decision: stop ? "stop" : "continue",
    reason: `ORCHESTRA_STOP_DECISION:${result.decision}:${result.reason}`,
    canonicalDecision: result.decision,
  });
}

function canonicalRuntimeDecision(input) {
  let payload;
  try { payload = JSON.parse(input || "{}"); } catch { return null; }
  const repoRoot = repoRootFrom(payload);
  const activeState = readJson(resolve(repoRoot, ".agents/state/active-state.json"), null);
  if (!activeState) return null;
  const leaseState = readWorkLease(repoRoot);
  if (!leaseState.exists || !leaseState.valid || !leaseState.lease) return null;
  return evaluateCanonicalStopState({ activeState, lease: leaseState.lease });
}

function delegate(input) {
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

function main() {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch {}
  const canonical = canonicalRuntimeDecision(input);
  if (canonical) {
    console.log(JSON.stringify({ decision: canonical.decision, reason: canonical.reason }));
    return;
  }
  delegate(input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
