import { LOGICAL_ROLES, assertLogicalRole } from "../../core/domain/logical-role.mjs";

const PROFILE = Object.freeze({
  CONTROL: Object.freeze({ profile: "sol-medium", model: "gpt-6-sol", reasoningEffort: "medium" }),
  IMPLEMENTER_SIMPLE: Object.freeze({ profile: "luna-high", model: "gpt-6-luna", reasoningEffort: "high" }),
  IMPLEMENTER_MECHANICAL: Object.freeze({ profile: "luna-medium", model: "gpt-6-luna", reasoningEffort: "medium" }),
  IMPLEMENTER_STANDARD: Object.freeze({ profile: "luna-max", model: "gpt-6-luna", reasoningEffort: "max" }),
  INVESTIGATOR_HIGH: Object.freeze({ profile: "sol-high", model: "gpt-6-sol", reasoningEffort: "high" }),
  INVESTIGATOR_XHIGH: Object.freeze({ profile: "sol-xhigh", model: "gpt-6-sol", reasoningEffort: "xhigh" }),
  INVESTIGATOR_MAX: Object.freeze({ profile: "sol-max", model: "gpt-6-sol", reasoningEffort: "max" }),
  QUICK_AUDITOR: Object.freeze({ profile: "luna-auditor", model: "gpt-6-luna", reasoningEffort: "medium" }),
  CRITICAL_REVIEWER: Object.freeze({ profile: "sol-review-low", model: "gpt-6-sol", reasoningEffort: "low" }),
  CRITICAL_REVIEWER_SPECIALIST: Object.freeze({ profile: "sol-review-medium", model: "gpt-6-sol", reasoningEffort: "medium" }),
  MANUAL_ESCALATION: Object.freeze({ profile: "astra-manual", model: "gpt-6-astra", reasoningEffort: "medium" }),
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
      if (["simple", "light"].includes(intensity)) return PROFILE.IMPLEMENTER_SIMPLE;
      if (["mechanical", "support"].includes(intensity)) return PROFILE.IMPLEMENTER_MECHANICAL;
      return PROFILE.IMPLEMENTER_STANDARD;
    case LOGICAL_ROLES.INVESTIGATOR:
      if (intensity === "max") return PROFILE.INVESTIGATOR_MAX;
      if (intensity === "xhigh") return PROFILE.INVESTIGATOR_XHIGH;
      return PROFILE.INVESTIGATOR_HIGH;
    case LOGICAL_ROLES.QUICK_AUDITOR:
      return PROFILE.QUICK_AUDITOR;
    case LOGICAL_ROLES.CRITICAL_REVIEWER:
      return ["specialist", "medium"].includes(intensity)
        ? PROFILE.CRITICAL_REVIEWER_SPECIALIST
        : PROFILE.CRITICAL_REVIEWER;
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
