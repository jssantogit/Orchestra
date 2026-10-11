export const EXECUTION_MODES = Object.freeze({
  DIRECT_WORK: 'DIRECT_WORK',
  GUIDED_WORK: 'GUIDED_WORK',
  ORCHESTRATED_WORK: 'ORCHESTRATED_WORK',
});

const MODE_RANK = Object.freeze({
  [EXECUTION_MODES.DIRECT_WORK]: 0,
  [EXECUTION_MODES.GUIDED_WORK]: 1,
  [EXECUTION_MODES.ORCHESTRATED_WORK]: 2,
});

function normalizeCriticality(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : 'NORMAL';
}

function requestedEscalation(current, requested) {
  if (!(requested in MODE_RANK)) return current;
  return MODE_RANK[requested] > MODE_RANK[current] ? requested : current;
}

export function selectExecutionMode(taskFacts = {}) {
  const facts = taskFacts && typeof taskFacts === 'object' ? taskFacts : {};
  const criticality = normalizeCriticality(facts.criticality);
  const workstreams = Number.isFinite(facts.independentWorkstreams)
    ? Math.max(0, facts.independentWorkstreams)
    : 1;

  let mode;
  let reason;

  if (workstreams > 1) {
    mode = EXECUTION_MODES.ORCHESTRATED_WORK;
    reason = 'MULTIPLE_INDEPENDENT_WORKSTREAMS';
  } else if (facts.migrationSensitive === true && criticality === 'CRITICAL') {
    mode = EXECUTION_MODES.ORCHESTRATED_WORK;
    reason = 'CRITICAL_MIGRATION';
  } else if (facts.unresolvedDiagnosis === true || facts.openEndedDiagnosis === true) {
    mode = EXECUTION_MODES.GUIDED_WORK;
    reason = 'UNRESOLVED_DIAGNOSIS';
  } else if (facts.bounded === false) {
    mode = EXECUTION_MODES.GUIDED_WORK;
    reason = 'UNBOUNDED_SCOPE';
  } else {
    mode = EXECUTION_MODES.DIRECT_WORK;
    reason = 'BOUNDED_DIRECT_WORK';
  }

  const escalated = requestedEscalation(mode, facts.requestedMode);
  if (escalated !== mode) {
    mode = escalated;
    reason = 'EXPLICIT_ESCALATION';
  }

  const lowRiskDirectWork = mode === EXECUTION_MODES.DIRECT_WORK && (
    facts.mechanical === true || facts.lowRisk === true || criticality === 'LOW'
  );

  return Object.freeze({ mode, reason, auditRequired: !lowRiskDirectWork });
}
