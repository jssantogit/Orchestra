import { createHash } from "node:crypto";

import { EXPERIENCE_DOMAIN_COHORTS } from "../experience/contracts.mjs";
import { validateLearnedPolicyCandidate } from "./policy-store.mjs";

// This pure reducer has NO permission to persist, activate or promote policies.
// Its input is a bounded, sanitized decision/outcome claim. Native journal
// verification and durable observation capture must occur upstream before use.
const INPUT_KEYS = new Set([
  "policyId", "revision", "createdAt", "domainCohort", "trainLineageIds", "observations",
]);
const OBSERVATION_KEYS = new Set([
  "schema", "version", "phase", "source", "domainCohort", "decision",
  "outcome", "privacy", "evidence",
]);
const TOKEN = /^[A-Z][A-Z0-9_]{0,127}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const EVIDENCE_REF = /^sha256:[a-f0-9]{64}$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, required = allowed) {
  return record(value)
    && Object.keys(value).every((key) => allowed.has(key))
    && [...required].every((key) => Object.hasOwn(value, key));
}

function tokens(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((part) => typeof part === "string" && TOKEN.test(part))
    && new Set(value).size === value.length;
}

function validObservation(value, domainCohort) {
  if (!exactKeys(value, OBSERVATION_KEYS)
    || value.schema !== "orchestra.rsi-decision-outcome.v1"
    || value.version !== 1
    || value.phase !== "TRAIN"
    || value.domainCohort !== domainCohort
    || !exactKeys(value.source, new Set(["lineageId", "operationId"]))
    || !ID.test(value.source.lineageId)
    || !ID.test(value.source.operationId)
    || !exactKeys(value.decision, new Set(["immutableRoutes", "legalRoutes", "selectedRoute"]))
    || !tokens(value.decision.immutableRoutes)
    || !tokens(value.decision.legalRoutes)
    || !TOKEN.test(value.decision.selectedRoute)
    || !value.decision.legalRoutes.includes(value.decision.selectedRoute)
    || !value.decision.immutableRoutes.includes(value.decision.selectedRoute)
    || !value.decision.legalRoutes.every((route) => value.decision.immutableRoutes.includes(route))
    || !exactKeys(value.outcome, new Set(["success", "retryCount", "durationMs"]))
    || value.outcome.success !== true
    || !Number.isSafeInteger(value.outcome.retryCount) || value.outcome.retryCount < 0
    || !Number.isSafeInteger(value.outcome.durationMs) || value.outcome.durationMs < 0
    || !exactKeys(value.privacy, new Set(["containsRawProjectContent"]))
    || value.privacy.containsRawProjectContent !== false
    || !exactKeys(value.evidence, new Set(["choiceRef", "outcomeRef"]))
    || !EVIDENCE_REF.test(value.evidence.choiceRef)
    || !EVIDENCE_REF.test(value.evidence.outcomeRef)) {
    return false;
  }
  return true;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function fail(code) {
  return Object.freeze({ ok: false, code });
}

export function deriveNativeRouteCandidate(input = {}) {
  if (!exactKeys(input, INPUT_KEYS)
    || typeof input.policyId !== "string" || !ID.test(input.policyId)
    || !Number.isInteger(input.revision) || input.revision < 1
    || typeof input.createdAt !== "string"
    || !Number.isFinite(Date.parse(input.createdAt))
    || !EXPERIENCE_DOMAIN_COHORTS.includes(input.domainCohort)
    || !Array.isArray(input.observations) || input.observations.length < 2
    || !Array.isArray(input.trainLineageIds)
    || input.trainLineageIds.length < 2
    || !input.trainLineageIds.every((lineageId) => typeof lineageId === "string" && ID.test(lineageId))) {
    return fail("RSI_TRAIN_INPUT_INVALID");
  }
  const declared = new Set(input.trainLineageIds);
  if (declared.size !== input.trainLineageIds.length) {
    return fail("RSI_TRAIN_LINEAGES_INVALID");
  }

  if (input.observations.some((item) => !validObservation(item, input.domainCohort))) {
    return fail("RSI_TRAIN_OBSERVATION_INVALID");
  }
  // Do not promote a tautology: observing the only possible action is not
  // evidence that a learned preference improves a nontrivial policy choice.
  if (input.observations.some((item) => item.decision.immutableRoutes.length < 2
    || item.decision.legalRoutes.length < 2)) {
    return fail("RSI_TRAIN_CHOICE_SPACE_INSUFFICIENT");
  }

  const actual = new Set(input.observations.map((item) => item.source.lineageId));
  if (actual.size !== declared.size || [...actual].some((item) => !declared.has(item))) {
    return fail("RSI_TRAIN_LINEAGES_INVALID");
  }
  const operations = new Set(input.observations.map((item) =>
    `${item.source.lineageId}\0${item.source.operationId}`));
  if (operations.size !== input.observations.length) {
    return fail("RSI_TRAIN_OPERATION_REPLAY");
  }
  const receipts = input.observations.flatMap((item) => [
    item.evidence.choiceRef, item.evidence.outcomeRef,
  ]);
  if (new Set(receipts).size !== receipts.length) {
    return fail("RSI_TRAIN_RECEIPT_REUSED");
  }

  // Conservative consensus: never rank, infer or propose an unobserved route.
  // If TRAIN is ambiguous, fail rather than pick a winner.
  const observed = new Set(input.observations.map((item) => item.decision.selectedRoute));
  if (observed.size !== 1) return fail("RSI_TRAIN_NO_CONSENSUS");
  const routePreference = [...observed][0];

  const candidate = {
    schema: "orchestra.learned-policy.v2",
    version: 1,
    policyId: input.policyId,
    revision: input.revision,
    scope: "DOMAIN",
    domainCohort: input.domainCohort,
    projectId: null,
    lifecycle: "CANDIDATE",
    selectors: { routePreference },
    createdAt: input.createdAt,
  };
  if (!validateLearnedPolicyCandidate(candidate).valid) {
    return fail("RSI_TRAIN_CANDIDATE_INVALID");
  }

  const observations = [...input.observations].sort((a, b) =>
    a.source.lineageId.localeCompare(b.source.lineageId)
    || a.source.operationId.localeCompare(b.source.operationId));
  const sourceDigest = "sha256:" + createHash("sha256")
    .update(JSON.stringify(canonicalize(observations)))
    .digest("hex");
  const evidence = Object.freeze({
    schema: "orchestra.rsi-train-derivation.v1",
    version: 1,
    sourceDigest,
    trainLineageIds: Object.freeze([...declared].sort()),
    observedRoute: routePreference,
    observationCount: observations.length,
  });
  return Object.freeze({
    ok: true,
    code: "RSI_TRAIN_CANDIDATE_DERIVED",
    candidate: Object.freeze(candidate),
    evidence,
  });
}
