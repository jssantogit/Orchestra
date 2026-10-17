import {
  EXPERIENCE_CATEGORIES,
  EXPERIENCE_DOMAIN_COHORTS,
} from "../experience/contracts.mjs";
import { validateLearnedPolicyCandidate } from "./policy-store.mjs";

const DIMENSIONS = Object.freeze([
  Object.freeze({ choices: "routes", allowed: "allowedRoutes", preference: "routePreference", output: "route" }),
  Object.freeze({ choices: "providerProfiles", allowed: "allowedProviderProfiles", preference: "providerProfilePreference", output: "providerProfile" }),
  Object.freeze({ choices: "retryClasses", allowed: "allowedRetryClasses", preference: "retryClass", output: "retryClass" }),
  Object.freeze({ choices: "timeoutClasses", allowed: "allowedTimeoutClasses", preference: "timeoutClass", output: "timeoutClass" }),
  Object.freeze({ choices: "turnEconomy", allowed: "allowedTurnEconomy", preference: "turnEconomy", output: "turnEconomy" }),
]);

const EXPERIENCE_CATEGORIES_SET = new Set(EXPERIENCE_CATEGORIES);
const EXPERIENCE_DOMAIN_COHORT_SET = new Set(EXPERIENCE_DOMAIN_COHORTS);
const EXPERIENCE_KEYS = new Set([
  "schema", "version", "experienceId", "category", "source", "domainCohort",
  "facts", "outcome", "generalization", "privacy",
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
const GENERALIZATION_KEYS = new Set(["scope", "projectLineageCount"]);
const PRIVACY_KEYS = new Set(["projectionVersion", "containsRawProjectContent"]);
const GENERALIZATION_SCOPES = new Set(["PROJECT", "DOMAIN", "GLOBAL_CANDIDATE"]);
const PROMOTION_GATE_KEYS = new Set(["minTrainLineages", "requireSuccess", "metrics"]);
const PROMOTION_METRICS = new Set(["retryCount", "durationMs"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validChoices(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(item))
    && new Set(value).size === value.length;
}

function applies(policy, { domainCohort, projectId }) {
  if (!policy) return false;
  if (policy.scope === "GLOBAL") return true;
  if (policy.scope === "DOMAIN") return policy.domainCohort === domainCohort;
  if (policy.scope === "PROJECT") return policy.projectId === projectId;
  return false;
}

function evaluationFailure(code, payload = {}) {
  return Object.freeze({ ok: false, passed: false, code, ...payload });
}

function validPromotionGate(gate) {
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

function validCrossProjectExperience(record, gate) {
  if (!isRecord(record)
    || !onlyKeys(record, EXPERIENCE_KEYS)
    || record.schema !== "orchestra.experience.v2"
    || record.version !== 1
    || typeof record.experienceId !== "string"
    || !/^exp-[0-9a-f]{24}$/.test(record.experienceId)
    || !EXPERIENCE_CATEGORIES_SET.has(record.category)
    || !isRecord(record.source)
    || Object.keys(record.source).length !== 1
    || typeof record.source.lineageId !== "string"
    || record.source.lineageId.length === 0
    || !EXPERIENCE_DOMAIN_COHORT_SET.has(record.domainCohort)
    || !isRecord(record.facts)
    || !onlyKeys(record.facts, FACT_KEYS)
    || !isRecord(record.outcome)
    || !onlyKeys(record.outcome, OUTCOME_KEYS)
    || !isRecord(record.generalization)
    || !onlyKeys(record.generalization, GENERALIZATION_KEYS)
    || !GENERALIZATION_SCOPES.has(record.generalization.scope)
    || !Number.isInteger(record.generalization.projectLineageCount)
    || record.generalization.projectLineageCount < 1
    || !isRecord(record.privacy)
    || !onlyKeys(record.privacy, PRIVACY_KEYS)
    || typeof record.privacy.projectionVersion !== "string"
    || record.privacy.projectionVersion.length === 0
    || record.privacy.containsRawProjectContent !== false) {
    return false;
  }

  if (gate.requireSuccess && typeof record.outcome.success !== "boolean") return false;
  for (const metric of Object.keys(gate.metrics)) {
    if (!Number.isInteger(record.facts[metric]) || record.facts[metric] < 0) return false;
  }
  return true;
}

function normalizeCohort(cohort, gate) {
  if (!isRecord(cohort) || !Array.isArray(cohort.lineageIds) || !Array.isArray(cohort.records)) return null;
  const records = [...cohort.records];
  if (records.some((record) => !validCrossProjectExperience(record, gate))) return null;
  const derivedLineages = [...new Set(records.map((record) => record.source.lineageId))].sort();
  const declaredLineages = [...cohort.lineageIds].sort();
  if (declaredLineages.length !== derivedLineages.length
    || declaredLineages.some((lineageId, index) => lineageId !== derivedLineages[index])) {
    return null;
  }
  return Object.freeze({
    lineageIds: Object.freeze(derivedLineages),
    records: Object.freeze(records.sort((left, right) => left.experienceId.localeCompare(right.experienceId))),
  });
}

function recordInCandidateScope(record, candidate) {
  if (candidate.scope === "GLOBAL") return record.generalization.scope === "GLOBAL_CANDIDATE";
  if (candidate.scope === "DOMAIN") {
    return record.domainCohort === candidate.domainCohort
      && ["DOMAIN", "GLOBAL_CANDIDATE"].includes(record.generalization.scope);
  }
  return false;
}

function scopedCohort(cohort, candidate) {
  const records = cohort.records.filter((record) => recordInCandidateScope(record, candidate));
  return Object.freeze({
    lineageIds: Object.freeze([...new Set(records.map((record) => record.source.lineageId))].sort()),
    records: Object.freeze(records),
  });
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

function cohortEvidence(cohort, gate) {
  const successCount = cohort.records.filter((record) => record.outcome.success === true).length;
  const metrics = {
    recordCount: cohort.records.length,
    successCount,
    successRate: cohort.records.length === 0 ? 0 : successCount / cohort.records.length,
  };
  for (const metric of Object.keys(gate.metrics).sort()) {
    metrics[metric] = metricSummary(cohort.records, metric);
  }
  return Object.freeze({
    lineageIds: Object.freeze([...cohort.lineageIds]),
    experienceIds: Object.freeze(cohort.records.map((record) => record.experienceId)),
    metrics: Object.freeze(metrics),
  });
}

function gateFailure(cohort, gate, phase) {
  if (gate.requireSuccess) {
    const failed = cohort.records.find((record) => record.outcome.success !== true);
    if (failed) {
      return Object.freeze({ phase, outcome: "success", experienceId: failed.experienceId });
    }
  }
  for (const metric of Object.keys(gate.metrics).sort()) {
    const rule = gate.metrics[metric];
    const failed = cohort.records.find((record) => record.facts[metric] > rule.max);
    if (failed) {
      return Object.freeze({
        phase,
        metric,
        expectedMax: rule.max,
        actual: failed.facts[metric],
        experienceId: failed.experienceId,
      });
    }
  }
  return null;
}

export function evaluatePolicyCandidate({ candidate, cohorts, gate } = {}) {
  const candidateValidation = validateLearnedPolicyCandidate(candidate);
  if (!candidateValidation.valid) return evaluationFailure("RSI_POLICY_INVALID");
  if (!validPromotionGate(gate)) return evaluationFailure("RSI_PROMOTION_GATE_INVALID");
  if (!isRecord(cohorts)) return evaluationFailure("RSI_COHORTS_INVALID");

  const train = normalizeCohort(cohorts.train, gate);
  const evaluate = normalizeCohort(cohorts.evaluate, gate);
  if (!train || !evaluate) return evaluationFailure("RSI_EXPERIENCE_INVALID");

  const trainLineages = new Set(train.lineageIds);
  if (evaluate.lineageIds.some((lineageId) => trainLineages.has(lineageId))) {
    return evaluationFailure("RSI_EVALUATE_LINEAGE_OVERLAP");
  }

  const scopedTrain = scopedCohort(train, candidate);
  const scopedEvaluate = scopedCohort(evaluate, candidate);
  if (candidate.scope === "GLOBAL"
    && (scopedTrain.lineageIds.length !== train.lineageIds.length
      || scopedEvaluate.lineageIds.length !== evaluate.lineageIds.length)) {
    return evaluationFailure("RSI_GLOBAL_EVIDENCE_SCOPE_INSUFFICIENT");
  }
  if (candidate.scope === "DOMAIN"
    && (scopedTrain.lineageIds.length !== train.lineageIds.length
      || scopedEvaluate.lineageIds.length !== evaluate.lineageIds.length)) {
    return evaluationFailure("RSI_DOMAIN_EVIDENCE_SCOPE_INSUFFICIENT");
  }
  if (candidate.scope === "PROJECT") {
    return evaluationFailure("RSI_PROJECT_EVIDENCE_REQUIRES_PRIVATE_SCOPE");
  }

  if (scopedTrain.lineageIds.length < gate.minTrainLineages) {
    return evaluationFailure("RSI_TRAIN_LINEAGE_SUPPORT_INSUFFICIENT", {
      distinctTrainLineages: scopedTrain.lineageIds.length,
      requiredTrainLineages: gate.minTrainLineages,
    });
  }
  if (scopedEvaluate.lineageIds.length < 1) {
    return evaluationFailure("RSI_EVALUATE_LINEAGE_SUPPORT_INSUFFICIENT");
  }

  const counterexamples = [...scopedTrain.records, ...scopedEvaluate.records]
    .filter((record) => record.category === "COUNTEREXAMPLE")
    .map((record) => record.experienceId)
    .sort();
  if (counterexamples.length > 0) {
    return evaluationFailure("RSI_COUNTEREXAMPLE_BLOCKS_PROMOTION", {
      counterexampleExperienceIds: Object.freeze(counterexamples),
    });
  }

  const trainFailure = gateFailure(scopedTrain, gate, "TRAIN");
  if (trainFailure) return evaluationFailure("RSI_TRAIN_GATE_FAILED", { failure: trainFailure });
  const evaluateFailure = gateFailure(scopedEvaluate, gate, "EVALUATE");
  if (evaluateFailure) return evaluationFailure("RSI_EVALUATE_GATE_FAILED", { failure: evaluateFailure });

  const evidence = Object.freeze({
    schema: "orchestra.rsi-promotion-evidence.v2",
    version: 1,
    policy: Object.freeze({ policyId: candidate.policyId, revision: candidate.revision, scope: candidate.scope }),
    gate: Object.freeze(structuredClone(gate)),
    train: cohortEvidence(scopedTrain, gate),
    evaluate: cohortEvidence(scopedEvaluate, gate),
  });

  return Object.freeze({
    ok: true,
    passed: true,
    code: "RSI_EVALUATION_PASSED",
    evidence,
  });
}

export function resolveLearnedPolicyHierarchy({
  immutableChoices,
  globalPolicy = null,
  domainPolicy = null,
  projectPolicy = null,
  domainCohort = null,
  projectId = null,
} = {}) {
  if (!immutableChoices || DIMENSIONS.some(({ choices }) => !validChoices(immutableChoices[choices]))) {
    return { ok: false, reason: "RSI_IMMUTABLE_CHOICES_INVALID" };
  }

  const legalChoices = Object.fromEntries(DIMENSIONS.map(({ choices }) => [choices, [...immutableChoices[choices]]]));
  const preferences = Object.fromEntries(DIMENSIONS.map(({ choices, output }) => [output, legalChoices[choices][0]]));
  const appliedPolicies = [];

  for (const policy of [globalPolicy, domainPolicy, projectPolicy]) {
    if (!policy || !applies(policy, { domainCohort, projectId })) continue;
    const validation = validateLearnedPolicyCandidate(policy);
    if (!validation.valid) return { ok: false, reason: "RSI_POLICY_INVALID", policyId: policy?.policyId ?? null };

    for (const { choices, allowed, preference, output } of DIMENSIONS) {
      const bounded = policy.selectors[allowed];
      if (bounded) {
        legalChoices[choices] = legalChoices[choices].filter((choice) => bounded.includes(choice));
        if (legalChoices[choices].length === 0) {
          return { ok: false, reason: "RSI_POLICY_NO_LEGAL_CHOICE", policyId: policy.policyId, dimension: choices };
        }
      }
      const preferred = policy.selectors[preference];
      if (preferred && legalChoices[choices].includes(preferred)) preferences[output] = preferred;
      if (!legalChoices[choices].includes(preferences[output])) preferences[output] = legalChoices[choices][0];
    }
    appliedPolicies.push(Object.freeze({ policyId: policy.policyId, revision: policy.revision, scope: policy.scope }));
  }

  return Object.freeze({
    ok: true,
    legalChoices: Object.freeze(Object.fromEntries(
      Object.entries(legalChoices).map(([key, value]) => [key, Object.freeze([...value])]),
    )),
    preferences: Object.freeze({ ...preferences }),
    appliedPolicies: Object.freeze(appliedPolicies),
  });
}
