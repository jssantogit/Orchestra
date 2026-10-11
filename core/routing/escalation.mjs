import { LOGICAL_ROLES, assertLogicalRole } from "../domain/logical-role.mjs";
import { classifyTask } from "./task-classification.mjs";

const INCONCLUSIVE = new Set(["FAILED", "FAILURE", "INCONCLUSIVE", "UNKNOWN", "BLOCKED"]);

function token(value, fallback = "") {
  const normalized = typeof value === "string"
    ? value.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : "";
  return normalized || fallback;
}

function investigationIntensity(value) {
  const normalized = token(value, "HIGH");
  if (["XHIGH", "X_HIGH", "VERY_HIGH"].includes(normalized)) return "xhigh";
  if (["MAX", "MAXIMUM"].includes(normalized)) return "max";
  return "high";
}

export function escalateTask({ task = {}, currentRole, result = {} } = {}) {
  assertLogicalRole(currentRole);
  const outcome = result && typeof result === "object" ? result : {};
  const classification = classifyTask(task);

  if (classification.logicalRole === LOGICAL_ROLES.MANUAL_ESCALATION) {
    return Object.freeze({
      nextRole: LOGICAL_ROLES.MANUAL_ESCALATION,
      intensity: "manual",
      terminal: true,
      reason: "DANGEROUS_SIDE_EFFECT_MANUAL_GATE",
    });
  }

  if (outcome.manualRequested === true) {
    return Object.freeze({
      nextRole: LOGICAL_ROLES.MANUAL_ESCALATION,
      intensity: "manual",
      terminal: true,
      reason: "EXPLICIT_MANUAL_ESCALATION_REQUESTED",
    });
  }

  if (classification.logicalRole === LOGICAL_ROLES.CRITICAL_REVIEWER
      && currentRole !== LOGICAL_ROLES.CRITICAL_REVIEWER) {
    return Object.freeze({
      nextRole: LOGICAL_ROLES.CRITICAL_REVIEWER,
      intensity: "standard",
      terminal: false,
      reason: "CRITICAL_ACCEPTANCE_REVIEW_REQUIRED",
    });
  }

  const status = token(outcome.status, "UNKNOWN");
  const diagnosisState = token(outcome.diagnosisState, "");

  if (["PASSED", "SUCCESS", "SUCCEEDED", "DONE", "ACCEPTED"].includes(status)) {
    return Object.freeze({
      nextRole: currentRole,
      intensity: investigationIntensity(outcome.currentIntensity),
      terminal: true,
      reason: "RESULT_SUCCEEDED",
    });
  }

  if (currentRole === LOGICAL_ROLES.IMPLEMENTER
      && (INCONCLUSIVE.has(status) || ["UNKNOWN", "UNRESOLVED", "LOW_CONFIDENCE"].includes(diagnosisState))) {
    return Object.freeze({
      nextRole: LOGICAL_ROLES.INVESTIGATOR,
      intensity: "high",
      terminal: false,
      reason: "IMPLEMENTATION_NEEDS_DIAGNOSIS",
    });
  }

  if (currentRole === LOGICAL_ROLES.INVESTIGATOR && INCONCLUSIVE.has(status)) {
    const currentIntensity = investigationIntensity(outcome.currentIntensity);
    if (currentIntensity === "high") {
      return Object.freeze({
        nextRole: LOGICAL_ROLES.INVESTIGATOR,
        intensity: "xhigh",
        terminal: false,
        reason: "DEEPER_INVESTIGATION_REQUIRED",
      });
    }
    if (currentIntensity === "xhigh") {
      return Object.freeze({
        nextRole: LOGICAL_ROLES.INVESTIGATOR,
        intensity: "max",
        terminal: false,
        reason: "DEEPER_INVESTIGATION_REQUIRED",
      });
    }
    return Object.freeze({
      nextRole: LOGICAL_ROLES.INVESTIGATOR,
      intensity: "max",
      terminal: true,
      reason: "INVESTIGATION_CEILING_REACHED",
    });
  }

  if (currentRole === LOGICAL_ROLES.QUICK_AUDITOR && INCONCLUSIVE.has(status)) {
    return Object.freeze({
      nextRole: LOGICAL_ROLES.IMPLEMENTER,
      intensity: "standard",
      terminal: false,
      reason: "AUDIT_REQUIRES_REPAIR",
    });
  }

  if (currentRole === LOGICAL_ROLES.CRITICAL_REVIEWER && INCONCLUSIVE.has(status)) {
    return Object.freeze({
      nextRole: LOGICAL_ROLES.IMPLEMENTER,
      intensity: "standard",
      terminal: false,
      reason: "CRITICAL_REVIEW_REQUIRES_REPAIR",
    });
  }

  return Object.freeze({
    nextRole: currentRole,
    intensity: classification.intensity,
    terminal: false,
    reason: "NO_ESCALATION_REQUIRED",
  });
}
