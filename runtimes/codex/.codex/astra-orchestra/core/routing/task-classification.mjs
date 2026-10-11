import { LOGICAL_ROLES } from "../domain/logical-role.mjs";
import { EXECUTION_MODES, selectExecutionMode } from "../workflow/direct-work-policy.mjs";

const UNRESOLVED_DIAGNOSIS = new Set(["UNKNOWN", "UNRESOLVED", "LOW_CONFIDENCE", "OPEN", "INCONCLUSIVE"]);
const DANGEROUS_SIDE_EFFECTS = new Set([
  "DESTRUCTIVE_EXTERNAL",
  "EXTERNAL_DESTRUCTIVE",
  "REMOTE_DESTRUCTIVE",
  "PRODUCTION_MUTATION",
  "EXTERNAL_SIDE_EFFECT",
]);
const BROAD_BREADTH = new Set(["BROAD", "UNBOUNDED", "OPEN_ENDED", "UNKNOWN"]);

function token(value, fallback = "") {
  const normalized = typeof value === "string"
    ? value.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : "";
  return normalized || fallback;
}

function normalizeCriticality(value) {
  const normalized = token(value, "NORMAL");
  if (["CRITICAL", "SEVERE", "DESTRUCTIVE", "RELEASE_CRITICAL"].includes(normalized)) return "CRITICAL";
  if (["MAJOR", "HIGH", "IMPORTANT", "SIGNIFICANT"].includes(normalized)) return "MAJOR";
  if (["LOW", "TRIVIAL"].includes(normalized)) return "LOW";
  return "NORMAL";
}

function normalizeRole(value) {
  const normalized = token(value, "IMPLEMENTATION");
  const aliases = {
    IMPLEMENT: "IMPLEMENTATION",
    IMPLEMENTER: "IMPLEMENTATION",
    BUILD: "IMPLEMENTATION",
    FIX: "IMPLEMENTATION",
    INVESTIGATE: "INVESTIGATION",
    INVESTIGATOR: "INVESTIGATION",
    REVIEW: "REVIEW",
    REVIEWER: "REVIEW",
    ACCEPT: "ACCEPTANCE",
    AUDIT: "QUICK_AUDIT",
    QUICK_AUDITOR: "QUICK_AUDIT",
    ORCHESTRATE: "CONTROL",
    ORCHESTRATION: "CONTROL",
  };
  return aliases[normalized] || normalized;
}

function isDangerousSideEffect(value) {
  const normalized = token(value, "UNKNOWN");
  return DANGEROUS_SIDE_EFFECTS.has(normalized)
    || (normalized.includes("EXTERNAL") && normalized.includes("DESTRUCTIVE"));
}

function isUnresolvedDiagnosis(value) {
  return UNRESOLVED_DIAGNOSIS.has(token(value, "UNKNOWN"));
}

function implementationIntensity({ breadth, criticality, mechanical }) {
  if (mechanical) return "mechanical";
  if (["TINY", "TRIVIAL", "SMALL"].includes(breadth) || criticality === "LOW") return "simple";
  if (BROAD_BREADTH.has(breadth) || criticality === "CRITICAL") return "high";
  return "standard";
}

function executionAssessment(task, { logicalRole, breadth, criticality, unresolvedDiagnosis, dangerous }) {
  let requestedMode = task.requestedMode;
  if (dangerous) requestedMode = EXECUTION_MODES.ORCHESTRATED_WORK;
  else if ([LOGICAL_ROLES.INVESTIGATOR, LOGICAL_ROLES.CRITICAL_REVIEWER, LOGICAL_ROLES.MANUAL_ESCALATION].includes(logicalRole)) {
    requestedMode = EXECUTION_MODES.GUIDED_WORK;
  }

  return selectExecutionMode({
    bounded: !BROAD_BREADTH.has(breadth) && task.bounded !== false,
    unresolvedDiagnosis,
    openEndedDiagnosis: token(task.diagnosisState) === "OPEN",
    independentWorkstreams: Number.isFinite(task.independentWorkstreams) ? task.independentWorkstreams : 1,
    migrationSensitive: task.migrationSensitive === true,
    criticality,
    mechanical: task.mechanical === true || ["MECHANICAL", "TRIVIAL"].includes(breadth),
    lowRisk: task.lowRisk === true || criticality === "LOW",
    requestedMode,
  });
}

export function classifyTask(task = {}) {
  const facts = task && typeof task === "object" ? task : {};
  const breadth = token(facts.breadth, facts.bounded === false ? "BROAD" : "BOUNDED");
  const diagnosisState = token(facts.diagnosisState, "UNKNOWN");
  const role = normalizeRole(facts.role || facts.taskRole || facts.action);
  const criticality = normalizeCriticality(facts.criticality);
  const dangerous = isDangerousSideEffect(facts.sideEffectClass);
  const unresolvedDiagnosis = isUnresolvedDiagnosis(diagnosisState);
  const reasons = [];

  let logicalRole;
  let intensity;

  if (dangerous) {
    logicalRole = LOGICAL_ROLES.MANUAL_ESCALATION;
    intensity = "manual";
    reasons.push("DANGEROUS_SIDE_EFFECT_MANUAL_GATE");
  } else if ((role === "ACCEPTANCE" || role === "REVIEW") && criticality === "CRITICAL") {
    logicalRole = LOGICAL_ROLES.CRITICAL_REVIEWER;
    intensity = "specialist";
    reasons.push("CRITICAL_ACCEPTANCE_REQUIRES_INDEPENDENT_REVIEW");
  } else if (role === "QUICK_AUDIT") {
    logicalRole = LOGICAL_ROLES.QUICK_AUDITOR;
    intensity = "standard";
    reasons.push("QUICK_AUDIT_REQUESTED");
  } else if (role === "INVESTIGATION" || unresolvedDiagnosis) {
    logicalRole = LOGICAL_ROLES.INVESTIGATOR;
    intensity = "high";
    reasons.push(unresolvedDiagnosis ? "DIAGNOSIS_UNRESOLVED" : "INVESTIGATION_REQUESTED");
  } else if (role === "CONTROL") {
    logicalRole = LOGICAL_ROLES.CONTROL;
    intensity = "standard";
    reasons.push("CONTROL_PLANE_TASK");
  } else if (role === "ACCEPTANCE" || role === "REVIEW") {
    logicalRole = LOGICAL_ROLES.CONTROL;
    intensity = "standard";
    reasons.push("NORMAL_ACCEPTANCE_CONTROL_PLANE");
  } else {
    logicalRole = LOGICAL_ROLES.IMPLEMENTER;
    intensity = implementationIntensity({
      breadth,
      criticality,
      mechanical: facts.mechanical === true || role === "MECHANICAL",
    });
    reasons.push("IMPLEMENTATION_TASK");
  }

  const directWorkAssessment = executionAssessment(facts, {
    logicalRole,
    breadth,
    criticality,
    unresolvedDiagnosis,
    dangerous,
  });

  if (directWorkAssessment.mode === EXECUTION_MODES.DIRECT_WORK) reasons.push("DIRECT_WORK_CANDIDATE");
  else if (directWorkAssessment.mode === EXECUTION_MODES.GUIDED_WORK) reasons.push("GUIDED_WORK_REQUIRED");
  else reasons.push("ORCHESTRATED_WORK_REQUIRED");

  return Object.freeze({
    logicalRole,
    intensity,
    directWorkAssessment,
    reasons: Object.freeze(reasons),
  });
}
