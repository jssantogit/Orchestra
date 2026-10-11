import { LOGICAL_ROLES, assertLogicalRole } from "../../core/domain/logical-role.mjs";

const PROFILE = Object.freeze({
  CONTROL: Object.freeze({ profile: "flash-orchestrator", model: "gemini-3.8-flash-medium", reasoningEffort: "medium" }),
  IMPLEMENTER_LOW: Object.freeze({ profile: "flash-low-worker", model: "gemini-3.8-flash-low", reasoningEffort: "low" }),
  IMPLEMENTER_STANDARD: Object.freeze({ profile: "flash-medium-worker", model: "gemini-3.8-flash-medium", reasoningEffort: "medium" }),
  IMPLEMENTER_HIGH: Object.freeze({ profile: "flash-worker", model: "gemini-3.8-flash-high", reasoningEffort: "high" }),
  INVESTIGATOR: Object.freeze({ profile: "flash-worker", model: "gemini-3.8-flash-high", reasoningEffort: "high" }),
  QUICK_AUDITOR: Object.freeze({ profile: "flash-quick-auditor", model: "gemini-3.8-flash-medium", reasoningEffort: "medium" }),
  CRITICAL_REVIEWER: Object.freeze({ profile: "flash-reviewer", model: "gemini-3.8-flash-high", reasoningEffort: "high" }),
  MANUAL_ESCALATION: Object.freeze({ profile: "flash-orchestrator", model: "gemini-3.8-flash-medium", reasoningEffort: "medium" }),
});

function normalized(value, fallback = "standard") {
  const text = String(value ?? "").trim().toLowerCase();
  return text || fallback;
}

function chooseProfile(logicalRole, intensity) {
  switch (logicalRole) {
    case LOGICAL_ROLES.CONTROL:
      return PROFILE.CONTROL;
    case LOGICAL_ROLES.IMPLEMENTER:
      if (["simple", "light", "low", "mechanical"].includes(intensity)) return PROFILE.IMPLEMENTER_LOW;
      if (["high", "complex", "max"].includes(intensity)) return PROFILE.IMPLEMENTER_HIGH;
      return PROFILE.IMPLEMENTER_STANDARD;
    case LOGICAL_ROLES.INVESTIGATOR:
      return PROFILE.INVESTIGATOR;
    case LOGICAL_ROLES.QUICK_AUDITOR:
      return PROFILE.QUICK_AUDITOR;
    case LOGICAL_ROLES.CRITICAL_REVIEWER:
      return PROFILE.CRITICAL_REVIEWER;
    case LOGICAL_ROLES.MANUAL_ESCALATION:
      return PROFILE.MANUAL_ESCALATION;
    default:
      throw new TypeError(`INVALID_LOGICAL_ROLE:${logicalRole}`);
  }
}

export function resolveModelProfile(logicalRole, { intensity = "standard", criticality = "NORMAL" } = {}) {
  assertLogicalRole(logicalRole);
  void criticality;
  const selected = chooseProfile(logicalRole, normalized(intensity));
  return {
    ...selected,
    logicalRole,
  };
}
