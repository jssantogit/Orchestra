import { evaluateDirectWorkAcceptance } from "./direct-work.mjs";

export const STOP_DECISIONS = Object.freeze({
  ACCEPT: "ACCEPT",
  CONTINUE: "CONTINUE",
  RETURN_TO_CONTROL: "RETURN_TO_CONTROL",
  BLOCKED: "BLOCKED",
  HUMAN_GATE: "HUMAN_GATE",
});

const STALE_REASONS = new Set([
  "PACKET_CANDIDATE_MISMATCH",
  "STALE_CANDIDATE_GENERATION",
  "STALE_EVIDENCE_GENERATION",
  "STALE_AUDIT_GENERATION",
]);
const CONTINUE_REASONS = new Set([
  "REQUIRED_EVIDENCE_NOT_PASSED",
  "AUDIT_REQUIRED",
  "AUDIT_NOT_PASSING",
]);

function result(decision, reason) {
  return Object.freeze({ decision, reason });
}

function validLease(lease) {
  return Boolean(
    lease
    && typeof lease === "object"
    && Number.isInteger(lease.generation)
    && lease.generation >= 0
    && typeof lease.workspaceId === "string"
    && lease.workspaceId
    && lease.actor
    && typeof lease.actor.provider === "string"
    && typeof lease.actor.sessionIdHash === "string",
  );
}

export function evaluateStopDecision({ workflow = {}, packet, candidate, evidence = [], audit = null, lease } = {}) {
  if (workflow?.humanGate === true || workflow?.requiresHumanGate === true) {
    return result(STOP_DECISIONS.HUMAN_GATE, "HUMAN_GATE_REQUIRED");
  }
  if (!validLease(lease)) return result(STOP_DECISIONS.BLOCKED, "WORK_LEASE_INVALID");
  if (workflow?.blocked === true) return result(STOP_DECISIONS.BLOCKED, workflow.reason || "WORKFLOW_BLOCKED");
  if (workflow?.returnToControl === true || workflow?.unresolvedDiagnosis === true) {
    return result(STOP_DECISIONS.RETURN_TO_CONTROL, workflow.reason || "RETURN_TO_CONTROL_REQUIRED");
  }

  const mode = String(workflow?.mode || "DIRECT_WORK").trim().toUpperCase();
  if (mode !== "DIRECT_WORK") return result(STOP_DECISIONS.CONTINUE, "WORKFLOW_NOT_READY_TO_ACCEPT");

  const acceptance = evaluateDirectWorkAcceptance({
    packet,
    candidate,
    evidence,
    audit,
    auditRequired: workflow?.auditRequired !== false,
    currentCandidateGeneration: candidate?.generation,
  });
  if (acceptance.accepted) return result(STOP_DECISIONS.ACCEPT, acceptance.reason);
  if (STALE_REASONS.has(acceptance.reason)) return result(STOP_DECISIONS.RETURN_TO_CONTROL, acceptance.reason);
  if (CONTINUE_REASONS.has(acceptance.reason)) return result(STOP_DECISIONS.CONTINUE, acceptance.reason);
  return result(STOP_DECISIONS.BLOCKED, acceptance.reason);
}
