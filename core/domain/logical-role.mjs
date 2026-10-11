export const LOGICAL_ROLES = Object.freeze({
  CONTROL: "CONTROL",
  IMPLEMENTER: "IMPLEMENTER",
  INVESTIGATOR: "INVESTIGATOR",
  QUICK_AUDITOR: "QUICK_AUDITOR",
  CRITICAL_REVIEWER: "CRITICAL_REVIEWER",
  MANUAL_ESCALATION: "MANUAL_ESCALATION",
});

const LOGICAL_ROLE_SET = new Set(Object.values(LOGICAL_ROLES));

export function isLogicalRole(value) {
  return typeof value === "string" && LOGICAL_ROLE_SET.has(value);
}

export function assertLogicalRole(value) {
  if (!isLogicalRole(value)) {
    throw new TypeError(`INVALID_LOGICAL_ROLE:${String(value ?? "")}`);
  }
  return value;
}
