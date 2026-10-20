import { createHash } from "node:crypto";

import { buildRsiCohorts } from "./cohorts.mjs";
import { deriveNativeRouteCandidate } from "./native-learning.mjs";
import { evaluatePolicyCandidate } from "./evaluation.mjs";
import { evaluateHoldoutReplay } from "./replay.mjs";

// Fixed, source-controlled gates: callers may select no weaker thresholds.
export const NATIVE_RSI_GATE = Object.freeze({
  minTrainLineages: 2,
  requireSuccess: true,
  metrics: Object.freeze({
    durationMs: Object.freeze({ max: 300_000 }),
  }),
});
const SEED = "orchestra-native-rsi-cohorts-v1";
const DOMAIN = "software-engineering";

function fail(code, stage = null) {
  return { ok: false, code, ...(stage ? { stage } : {}) };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function projectedExperience(observation, lineageCount) {
  const sourceDigest = hash(observation.evidence);
  return {
    schema: "orchestra.experience.v2",
    version: 1,
    experienceId: `exp-${sourceDigest.slice(7, 31)}`,
    category: "EXECUTION",
    source: { lineageId: observation.source.lineageId },
    domainCohort: DOMAIN,
    facts: {
      routeClass: observation.decision.selectedRoute,
      durationMs: observation.outcome.durationMs,
    },
    outcome: {
      terminalOutcome: observation.outcome.success ? "SUCCEEDED" : "FAILED",
      success: observation.outcome.success,
    },
    // This DOMAIN view is newly computed from independently verified native
    // observations. Original PROJECT Experience is never rewritten/promoted.
    generalization: { scope: "DOMAIN", projectLineageCount: lineageCount },
    privacy: { projectionVersion: "rsi-native-1", containsRawProjectContent: false },
  };
}

function prepare(nativeStore) {
  if (!nativeStore || typeof nativeStore.listObserved !== "function") {
    return fail("RSI_NATIVE_STORE_REQUIRED");
  }
  let observations;
  try {
    observations = nativeStore.listObserved();
  } catch {
    return fail("RSI_NATIVE_STORE_INVALID");
  }
  if (!Array.isArray(observations) || observations.length < 4
    || observations.some((item) => item?.schema !== "orchestra.rsi-decision-outcome.v1"
      || item.domainCohort !== DOMAIN || item.decision?.selectedRoute !== "DIRECT_WORK"
      || !item.evidence?.choiceRef || !item.evidence?.outcomeRef)) {
    return fail("RSI_NATIVE_OBSERVATIONS_INVALID");
  }
  const lineageCount = new Set(observations.map((item) => item.source?.lineageId)).size;
  if (lineageCount < 4) return fail("RSI_NATIVE_LINEAGES_INSUFFICIENT");
  const experiences = observations.map((item) => projectedExperience(item, lineageCount));
  const prepared = buildRsiCohorts({ experiences, seed: SEED, domainCohort: DOMAIN });
  if (!prepared.ok) return fail(prepared.code);
  const trainLineageIds = prepared.cohorts.train.lineageIds;
  const trainSet = new Set(trainLineageIds);
  const trainObservations = observations
    .filter((item) => trainSet.has(item.source.lineageId))
    .map((item) => ({ ...item, phase: "TRAIN" }));
  return { ok: true, cohorts: prepared.cohorts, trainObservations, trainLineageIds, lineageCount };
}

function derive(input, prepared) {
  return deriveNativeRouteCandidate({
    policyId: input.policyId,
    revision: input.revision,
    createdAt: input.createdAt,
    domainCohort: DOMAIN,
    trainLineageIds: prepared.trainLineageIds,
    observations: prepared.trainObservations,
  });
}

function checkEvaluation(candidate, prepared) {
  // Existing promotion/replay validators check success and performance.
  // This additional invariant ensures the candidate route was ACTUALLY used
  // by both independent unseen cohorts (not simply a syntactically legal value).
  for (const stage of ["evaluate", "holdout"]) {
    const rows = prepared.cohorts[stage].records;
    if (!rows.length || rows.some((record) =>
      record.facts.routeClass !== candidate.selectors.routePreference)) {
      return fail("RSI_NATIVE_ROUTE_NOT_OBSERVED", stage);
    }
  }
  const evaluation = evaluatePolicyCandidate({
    candidate, cohorts: prepared.cohorts, gate: NATIVE_RSI_GATE,
  });
  if (!evaluation.ok || !evaluation.passed) {
    return fail(evaluation.code || "RSI_NATIVE_EVALUATE_FAILED", "evaluate");
  }
  const replay = evaluateHoldoutReplay({
    candidate, promotionEvidence: evaluation.evidence,
    holdout: prepared.cohorts.holdout, gate: NATIVE_RSI_GATE,
  });
  if (!replay.ok || !replay.passed) {
    return fail(replay.code || "RSI_NATIVE_HOLDOUT_FAILED", "holdout");
  }
  return { ok: true, evaluation, replay };
}

// Training is an explicit, never-background state-changing action. It must
// operate on the native Home-backed journal; prebuilt Experience is not input.
export function trainNativeRsiCandidate({ nativeStore, policyStore, policyId, revision, createdAt } = {}) {
  if (!policyStore?.putCandidate || !nativeStore?.putTrainingReceipt) {
    return fail("RSI_NATIVE_PERSISTENCE_REQUIRED");
  }
  const prepared = prepare(nativeStore);
  if (!prepared.ok) return prepared;
  const derived = derive({ policyId, revision, createdAt }, prepared);
  if (!derived.ok) return derived;
  const checked = checkEvaluation(derived.candidate, prepared);
  if (!checked.ok) return checked;

  const receipt = {
    policyId, revision, seed: SEED,
    sourceDigest: derived.evidence.sourceDigest,
    candidateDigest: hash(derived.candidate),
    trainLineageIds: [...prepared.trainLineageIds].sort(),
  };
  const stored = policyStore.putCandidate(derived.candidate);
  if (!stored?.ok) return fail(stored?.reason || "RSI_NATIVE_CANDIDATE_PERSIST_FAILED");
  const provenance = nativeStore.putTrainingReceipt(receipt);
  if (!provenance?.ok) return fail(provenance?.code || "RSI_NATIVE_RECEIPT_PERSIST_FAILED");

  return {
    ok: true,
    code: "RSI_NATIVE_CANDIDATE_TRAINED",
    candidate: derived.candidate,
    sourceDigest: receipt.sourceDigest,
    receiptRef: provenance.receiptRef ?? null,
    lineageCount: prepared.lineageCount,
  };
}

// Canonical readiness uses this READ-ONLY function, which recomputes TRAIN
// from re-opened native events. Hand-authored candidates or receipts fail.
export function verifyNativeRsiReplay({ nativeStore, policyStore, policyId, revision } = {}) {
  if (!policyStore?.inspect || !nativeStore?.inspectTrainingReceipt) {
    return fail("RSI_NATIVE_PERSISTENCE_REQUIRED");
  }
  let candidate, receipt;
  try {
    candidate = policyStore.inspect(policyId, revision);
    receipt = nativeStore.inspectTrainingReceipt(policyId, revision);
  } catch {
    return fail("RSI_NATIVE_PERSISTED_EVIDENCE_INVALID");
  }
  if (!candidate) return fail("RSI_NATIVE_CANDIDATE_MISSING");
  if (!receipt) return fail("RSI_NATIVE_TRAINING_RECEIPT_MISSING");

  const prepared = prepare(nativeStore);
  if (!prepared.ok) return prepared;
  const derived = derive({
    policyId, revision, createdAt: candidate.createdAt,
  }, prepared);
  if (!derived.ok) return derived;
  if (receipt.policyId !== policyId || receipt.revision !== revision
    || receipt.seed !== SEED
    || receipt.sourceDigest !== derived.evidence.sourceDigest
    || receipt.candidateDigest !== hash(derived.candidate)
    || hash(candidate) !== receipt.candidateDigest
    || JSON.stringify([...receipt.trainLineageIds].sort())
      !== JSON.stringify([...prepared.trainLineageIds].sort())) {
    return fail("RSI_NATIVE_PROVENANCE_MISMATCH");
  }
  const checked = checkEvaluation(candidate, prepared);
  if (!checked.ok) return checked;
  return {
    ok: true,
    code: "RSI_NATIVE_REPLAY_PASSED",
    trainVerified: true,
    evaluateVerified: true,
    holdoutVerified: true,
    lineageCount: prepared.lineageCount,
    sourceDigest: receipt.sourceDigest,
    evidence: {
      policyId,
      revision,
      trainLineageCount: prepared.cohorts.train.lineageIds.length,
      evaluateLineageCount: prepared.cohorts.evaluate.lineageIds.length,
      holdoutLineageCount: prepared.cohorts.holdout.lineageIds.length,
      evaluation: checked.evaluation.evidence,
      replay: checked.replay.evidence,
    },
  };
}
