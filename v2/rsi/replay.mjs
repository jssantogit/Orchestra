import { validateLearnedPolicyCandidate } from "./policy-store.mjs";

const EXPERIENCE_KEYS = new Set([
  "schema", "version", "experienceId", "category", "source", "domainCohort",
  "facts", "outcome", "generalization", "privacy",
]);
const EXPERIENCE_CATEGORIES = new Set([
  "DIAGNOSTIC", "EXECUTION", "PROVIDER_TOOL_FACT", "PERFORMANCE", "COUNTEREXAMPLE",
]);
const FACT_KEYS = new Set([
  "failureClass", "recoveryClass", "providerFamily", "osFamily", "runtimeVersion",
  "providerAdapterVersion", "operationClass", "routeClass", "capabilityClass", "toolClass",
  "resultClass", "evidenceClass", "confidenceClass", "latencyBucket", "turnCount", "retryCount",
  "durationMs", "changedPathClass", "changedPathCount",
]);
const OUTCOME_KEYS = new Set([
  "terminalOutcome", "success", "failureClass", "recoveryClass", "resultClass",
]);
const GENERALIZATION_SCOPES = new Set(["PROJECT", "DOMAIN", "GLOBAL_CANDIDATE"]);
const PROMOTION_GATE_KEYS = new Set(["minTrainLineages", "requireSuccess", "metrics"]);
const PROMOTION_METRICS = new Set(["retryCount", "durationMs"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function replayFailure(code, payload = {}) {
  return Object.freeze({ ok: false, passed: false, code, ...payload });
}

function validGate(gate) {
  if (!isRecord(gate) || !onlyKeys(gate, PROMOTION_GATE_KEYS)) return false;
  if (!Number.isInteger(gate.minTrainLineages) || gate.minTrainLineages < 2) return false;
  if (typeof gate.requireSuccess !== "boolean") return false;
  if (!isRecord(gate.metrics) || !onlyKeys(gate.metrics, PROMOTION_METRICS)) return false;
  for (const [metric, rule] of Object.entries(gate.metrics)) {
    if (!PROMOTION_METRICS.has(metric) || !isRecord(rule) || !onlyKeys(rule, new Set(["max"]))) return false;
    if (typeof rule.max !== "number" || !Number.isFinite(rule.max) || rule.max < 0) return false;
  }
  return true;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validPromotionEvidence(evidence, candidate, gate) {
  if (!isRecord(evidence)
    || evidence.schema !== "orchestra.rsi-promotion-evidence.v2"
    || evidence.version !== 1
    || !isRecord(evidence.policy)
    || evidence.policy.policyId !== candidate.policyId
    || evidence.policy.revision !== candidate.revision
    || evidence.policy.scope !== candidate.scope
    || !isRecord(evidence.gate)
    || !sameJson(evidence.gate, gate)
    || !isRecord(evidence.train)
    || !Array.isArray(evidence.train.lineageIds)
    || !isRecord(evidence.evaluate)
    || !Array.isArray(evidence.evaluate.lineageIds)) {
    return false;
  }
  return evidence.train.lineageIds.every((lineageId) => typeof lineageId === "string" && lineageId.length > 0)
    && evidence.evaluate.lineageIds.every((lineageId) => typeof lineageId === "string" && lineageId.length > 0);
}

function validCrossProjectExperience(record) {
  if (!isRecord(record)
    || !onlyKeys(record, EXPERIENCE_KEYS)
    || record.schema !== "orchestra.experience.v2"
    || record.version !== 1
    || typeof record.experienceId !== "string"
    || !/^exp-[0-9a-f]{24}$/.test(record.experienceId)
    || !EXPERIENCE_CATEGORIES.has(record.category)
    || !isRecord(record.source)
    || Object.keys(record.source).length !== 1
    || typeof record.source.lineageId !== "string"
    || record.source.lineageId.length === 0
    || typeof record.domainCohort !== "string"
    || record.domainCohort.length === 0
    || !isRecord(record.facts)
    || !onlyKeys(record.facts, FACT_KEYS)
    || !isRecord(record.outcome)
    || !onlyKeys(record.outcome, OUTCOME_KEYS)
    || !isRecord(record.generalization)
    || !onlyKeys(record.generalization, new Set(["scope", "projectLineageCount"]))
    || !GENERALIZATION_SCOPES.has(record.generalization.scope)
    || !Number.isInteger(record.generalization.projectLineageCount)
    || record.generalization.projectLineageCount < 1
    || !isRecord(record.privacy)
    || !onlyKeys(record.privacy, new Set(["projectionVersion", "containsRawProjectContent"]))
    || typeof record.privacy.projectionVersion !== "string"
    || record.privacy.projectionVersion.length === 0
    || record.privacy.containsRawProjectContent !== false) {
    return false;
  }
  return true;
}

function normalizeHoldout(holdout) {
  if (!isRecord(holdout) || !Array.isArray(holdout.lineageIds) || !Array.isArray(holdout.records)) return null;
  if (holdout.records.length === 0 || holdout.records.some((record) => !validCrossProjectExperience(record))) return null;
  const lineages = [...new Set(holdout.records.map((record) => record.source.lineageId))].sort();
  const declared = [...holdout.lineageIds].sort();
  if (declared.length !== lineages.length || declared.some((lineageId, index) => lineageId !== lineages[index])) return null;
  return Object.freeze({
    lineageIds: Object.freeze(lineages),
    records: Object.freeze([...holdout.records].sort((left, right) => left.experienceId.localeCompare(right.experienceId))),
  });
}

function inCandidateScope(record, candidate) {
  if (candidate.scope === "GLOBAL") return record.generalization.scope === "GLOBAL_CANDIDATE";
  if (candidate.scope === "DOMAIN") {
    return record.domainCohort === candidate.domainCohort
      && ["DOMAIN", "GLOBAL_CANDIDATE"].includes(record.generalization.scope);
  }
  return false;
}

function metricSummary(records, metric) {
  const values = records.map((record) => record.facts[metric]);
  const total = values.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    count: values.length,
    total,
    average: values.length === 0 ? 0 : total / values.length,
    max: values.length === 0 ? 0 : Math.max(...values),
  });
}

function holdoutEvidence(holdout, gate) {
  const successCount = holdout.records.filter((record) => record.outcome.success === true).length;
  const metrics = {
    recordCount: holdout.records.length,
    successCount,
    successRate: holdout.records.length === 0 ? 0 : successCount / holdout.records.length,
  };
  for (const metric of Object.keys(gate.metrics).sort()) metrics[metric] = metricSummary(holdout.records, metric);
  return Object.freeze({
    lineageIds: Object.freeze([...holdout.lineageIds]),
    experienceIds: Object.freeze(holdout.records.map((record) => record.experienceId)),
    metrics: Object.freeze(metrics),
  });
}

function missingReplayFacts(holdout, gate) {
  for (const record of holdout.records) {
    if (gate.requireSuccess && typeof record.outcome.success !== "boolean") {
      return Object.freeze({ experienceId: record.experienceId, field: "outcome.success" });
    }
    for (const metric of Object.keys(gate.metrics).sort()) {
      if (!Number.isInteger(record.facts[metric]) || record.facts[metric] < 0) {
        return Object.freeze({ experienceId: record.experienceId, field: `facts.${metric}` });
      }
    }
  }
  return null;
}

function replayGateFailure(holdout, gate) {
  const counterexample = holdout.records.find((record) => record.category === "COUNTEREXAMPLE");
  if (counterexample) {
    return Object.freeze({ category: "COUNTEREXAMPLE", experienceId: counterexample.experienceId });
  }
  if (gate.requireSuccess) {
    const failed = holdout.records.find((record) => record.outcome.success !== true);
    if (failed) return Object.freeze({ outcome: "success", experienceId: failed.experienceId });
  }
  for (const metric of Object.keys(gate.metrics).sort()) {
    const rule = gate.metrics[metric];
    const failed = holdout.records.find((record) => record.facts[metric] > rule.max);
    if (failed) {
      return Object.freeze({
        metric,
        expectedMax: rule.max,
        actual: failed.facts[metric],
        experienceId: failed.experienceId,
      });
    }
  }
  return null;
}

export function evaluateHoldoutReplay({ candidate, promotionEvidence, holdout, gate } = {}) {
  const candidateValidation = validateLearnedPolicyCandidate(candidate);
  if (!candidateValidation.valid) return replayFailure("RSI_POLICY_INVALID");
  if (!validGate(gate)) return replayFailure("RSI_PROMOTION_GATE_INVALID");
  if (!validPromotionEvidence(promotionEvidence, candidate, gate)) {
    return replayFailure("RSI_PROMOTION_EVIDENCE_INVALID");
  }

  const normalized = normalizeHoldout(holdout);
  if (!normalized) return replayFailure("RSI_REPLAY_EXPERIENCE_INVALID");

  const priorLineages = new Set([
    ...promotionEvidence.train.lineageIds,
    ...promotionEvidence.evaluate.lineageIds,
  ]);
  if (normalized.lineageIds.some((lineageId) => priorLineages.has(lineageId))) {
    return replayFailure("RSI_HOLDOUT_LINEAGE_OVERLAP");
  }

  if (candidate.scope === "PROJECT") return replayFailure("RSI_PROJECT_EVIDENCE_REQUIRES_PRIVATE_SCOPE");
  const scopedRecords = normalized.records.filter((record) => inCandidateScope(record, candidate));
  const scopedLineages = [...new Set(scopedRecords.map((record) => record.source.lineageId))].sort();
  if (scopedRecords.length !== normalized.records.length || scopedLineages.length !== normalized.lineageIds.length) {
    return replayFailure(candidate.scope === "GLOBAL"
      ? "RSI_GLOBAL_HOLDOUT_SCOPE_INSUFFICIENT"
      : "RSI_DOMAIN_HOLDOUT_SCOPE_INSUFFICIENT");
  }

  const scopedHoldout = Object.freeze({
    lineageIds: Object.freeze(scopedLineages),
    records: Object.freeze(scopedRecords),
  });
  const missing = missingReplayFacts(scopedHoldout, gate);
  if (missing) return replayFailure("RSI_REPLAY_INSUFFICIENT_EVIDENCE", { missing });

  const failure = replayGateFailure(scopedHoldout, gate);
  if (failure) return replayFailure("RSI_REPLAY_GATE_FAILED", { failure });

  return Object.freeze({
    ok: true,
    passed: true,
    code: "RSI_REPLAY_PASSED",
    evidence: Object.freeze({
      schema: "orchestra.rsi-replay-evidence.v2",
      version: 1,
      policy: Object.freeze({
        policyId: candidate.policyId,
        revision: candidate.revision,
        scope: candidate.scope,
      }),
      promotion: Object.freeze({
        trainLineageIds: Object.freeze([...promotionEvidence.train.lineageIds].sort()),
        evaluateLineageIds: Object.freeze([...promotionEvidence.evaluate.lineageIds].sort()),
      }),
      holdout: holdoutEvidence(scopedHoldout, gate),
    }),
  });
}

export function evaluateCounterexampleDemotion({ candidate, counterexample } = {}) {
  const candidateValidation = validateLearnedPolicyCandidate(candidate);
  if (!candidateValidation.valid) {
    return Object.freeze({ ok: false, qualifies: false, code: "RSI_POLICY_INVALID" });
  }
  if (!validCrossProjectExperience(counterexample)) {
    return Object.freeze({ ok: false, qualifies: false, code: "RSI_COUNTEREXAMPLE_INVALID" });
  }
  if (counterexample.category !== "COUNTEREXAMPLE" || counterexample.outcome.success !== false) {
    return Object.freeze({ ok: true, qualifies: false, code: "RSI_COUNTEREXAMPLE_NOT_QUALIFYING" });
  }
  if (candidate.scope === "PROJECT" || !inCandidateScope(counterexample, candidate)) {
    return Object.freeze({ ok: true, qualifies: false, code: "RSI_COUNTEREXAMPLE_OUT_OF_SCOPE" });
  }
  return Object.freeze({
    ok: true,
    qualifies: true,
    code: "RSI_COUNTEREXAMPLE_DEMOTION_REQUIRED",
    evidence: Object.freeze({
      schema: "orchestra.rsi-counterexample-response.v2",
      version: 1,
      policy: Object.freeze({
        policyId: candidate.policyId,
        revision: candidate.revision,
        scope: candidate.scope,
      }),
      experienceId: counterexample.experienceId,
      lineageId: counterexample.source.lineageId,
      domainCohort: counterexample.domainCohort,
    }),
  });
}
