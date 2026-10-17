import { validateOperationV2 } from "../domain/contracts.mjs";
import {
  validateProviderEventObservationV2,
  validateRuntimeOwnerV2,
} from "./contracts.mjs";

function parseTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function assessment(operationId, observedAt, liveness, reason, evidence = {}) {
  return {
    schema: "orchestra.liveness-assessment.v2",
    operationId: operationId ?? null,
    observedAt,
    liveness,
    reason,
    evidence: {
      ownerStatus: null,
      heartbeatFresh: null,
      deadlineExpired: evidence.deadlineExpired ?? null,
      providerEventFresh: evidence.providerEventFresh ?? null,
      providerEventCorrelationMatched: evidence.providerEventCorrelationMatched ?? null,
    },
  };
}

export function assessProviderEventLiveness({
  operation,
  runtimeOwner,
  providerEventObservation,
  now,
  heartbeatMaxAgeMs = 30_000,
  ownerObservationMaxAgeMs = 15_000,
  futureSkewToleranceMs = 5_000,
} = {}) {
  const observedAt = now ?? new Date().toISOString();
  const nowMs = parseTime(observedAt);
  const operationId = operation?.operationId ?? null;
  if (nowMs === null || !Number.isFinite(heartbeatMaxAgeMs) || heartbeatMaxAgeMs < 0
    || !Number.isFinite(ownerObservationMaxAgeMs) || ownerObservationMaxAgeMs < 0
    || !Number.isFinite(futureSkewToleranceMs) || futureSkewToleranceMs < 0) {
    return assessment(operationId, observedAt, "UNKNOWN", "LIVENESS_POLICY_INVALID");
  }
  if (!validateOperationV2(operation).valid) {
    return assessment(operationId, observedAt, "UNKNOWN", "OPERATION_INVALID");
  }
  if (operation.liveness === "TERMINAL") {
    return assessment(operation.operationId, observedAt, "TERMINAL", "PERSISTED_TERMINAL");
  }
  if (!validateRuntimeOwnerV2(runtimeOwner).valid || runtimeOwner.kind !== "PROVIDER_EVENT") {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_OWNER_INVALID");
  }
  if (runtimeOwner.operationId !== operation.operationId
    || operation.runtimeOwnerRef !== runtimeOwner.runtimeOwnerId) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_OWNER_MISMATCH");
  }
  if (runtimeOwner.deadlineAt !== operation.deadlineAt) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_DEADLINE_MISMATCH");
  }
  if (runtimeOwner.startedAt !== operation.startedAt) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_START_MISMATCH");
  }
  if (providerEventObservation === null || providerEventObservation === undefined) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_MISSING");
  }
  if (!validateProviderEventObservationV2(providerEventObservation).valid) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_OBSERVATION_INVALID");
  }

  const correlationMatched = providerEventObservation.runtimeOwnerId === runtimeOwner.runtimeOwnerId
    && providerEventObservation.correlationRef === runtimeOwner.correlationRef;
  const evidence = { providerEventCorrelationMatched: correlationMatched };
  if (!correlationMatched) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_CORRELATION_MISMATCH", evidence);
  }
  if (providerEventObservation.status !== "POSITIVE") {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_CONTRADICTORY", evidence);
  }

  const eventMs = parseTime(providerEventObservation.eventAt);
  const observationMs = parseTime(providerEventObservation.observedAt);
  const startedMs = parseTime(runtimeOwner.startedAt);
  const ownerEventMs = parseTime(runtimeOwner.lastProviderEventAt);
  const deadlineMs = parseTime(runtimeOwner.deadlineAt);
  if ([eventMs, observationMs, startedMs, ownerEventMs, deadlineMs].some((value) => value === null)) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_TIME_INVALID", evidence);
  }
  if (observationMs > nowMs + futureSkewToleranceMs) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_OBSERVATION_FUTURE_SKEW", evidence);
  }
  if (nowMs - observationMs > ownerObservationMaxAgeMs) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_OBSERVATION_STALE", evidence);
  }
  if (observationMs < eventMs) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_OBSERVATION_PRECEDES_EVENT", evidence);
  }
  if (eventMs > nowMs + futureSkewToleranceMs) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_FUTURE_SKEW", evidence);
  }
  if (eventMs < startedMs || eventMs !== ownerEventMs || eventMs > deadlineMs) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_REORDERED", evidence);
  }

  const eventFresh = nowMs - eventMs <= heartbeatMaxAgeMs;
  const deadlineExpired = deadlineMs < nowMs;
  const classifiedEvidence = {
    ...evidence,
    providerEventFresh: eventFresh,
    deadlineExpired,
  };
  if (deadlineExpired) {
    if (eventFresh) {
      return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_FRESH_AFTER_DEADLINE", classifiedEvidence);
    }
    return assessment(operation.operationId, observedAt, "STALE_RECOVERABLE", "PROVIDER_EVENT_DEADLINE_EXPIRED_STALE", classifiedEvidence);
  }
  if (!eventFresh) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "PROVIDER_EVENT_STALE_DEADLINE_OPEN", classifiedEvidence);
  }
  return assessment(operation.operationId, observedAt, "LIVE", "PROVIDER_EVENT_FRESH_DEADLINE_OPEN", classifiedEvidence);
}
