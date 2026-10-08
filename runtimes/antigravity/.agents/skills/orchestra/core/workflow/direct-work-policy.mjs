export const EXECUTION_MODES = Object.freeze({
  DIRECT_WORK: "DIRECT_WORK",
  GUIDED_WORK: "GUIDED_WORK",
  ORCHESTRATED_WORK: "ORCHESTRATED_WORK",
});

const MODE_RANK = Object.freeze({
  [EXECUTION_MODES.DIRECT_WORK]: 0,
  [EXECUTION_MODES.GUIDED_WORK]: 1,
  [EXECUTION_MODES.ORCHESTRATED_WORK]: 2,
});

function normalizedCriticality(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "NORMAL";
}

function explicitEscalation(baseMode, requestedMode) {
  if (!(requestedMode in MODE_RANK)) return baseMode;
  return MODE_RANK[requestedMode] > MODE_RANK[baseMode] ? requestedMode : baseMode;
}

export function selectExecutionMode(taskFacts = {}) {
  const facts = taskFacts && typeof taskFacts === "object" ? taskFacts : {};
  const criticality = normalizedCriticality(facts.criticality);
  const workstreams = Number.isFinite(facts.independentWorkstreams)
    ? Math.max(0, facts.independentWorkstreams)
    : 1;

  const criticalMigration = facts.migrationSensitive === true && criticality === "CRITICAL";
  let mode;
  let reason;

  if (workstreams > 1) {
    mode = EXECUTION_MODES.ORCHESTRATED_WORK;
    reason = "MULTIPLE_INDEPENDENT_WORKSTREAMS";
  } else if (criticalMigration) {
    mode = EXECUTION_MODES.ORCHESTRATED_WORK;
    reason = "CRITICAL_MIGRATION";
  } else if (facts.unresolvedDiagnosis === true || facts.openEndedDiagnosis === true) {
    mode = EXECUTION_MODES.GUIDED_WORK;
    reason = "UNRESOLVED_DIAGNOSIS";
  } else if (facts.bounded === false) {
    mode = EXECUTION_MODES.GUIDED_WORK;
    reason = "UNBOUNDED_SCOPE";
  } else {
    mode = EXECUTION_MODES.DIRECT_WORK;
    reason = "BOUNDED_DIRECT_WORK";
  }

  const escalatedMode = explicitEscalation(mode, facts.requestedMode);
  if (escalatedMode !== mode) {
    mode = escalatedMode;
    reason = "EXPLICIT_ESCALATION";
  }

  const lowRiskDirectWork = mode === EXECUTION_MODES.DIRECT_WORK && (
    facts.mechanical === true ||
    facts.lowRisk === true ||
    criticality === "LOW"
  );

  return Object.freeze({
    mode,
    reason,
    auditRequired: !lowRiskDirectWork,
  });
}
