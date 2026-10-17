import { validateOperationV2 } from "../domain/contracts.mjs";
import {
  validateOwnerObservationV2,
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
      ownerStatus: evidence.ownerStatus ?? null,
      heartbeatFresh: evidence.heartbeatFresh ?? null,
      deadlineExpired: evidence.deadlineExpired ?? null,
    },
  };
}

function heartbeatState(operation, nowMs, heartbeatMaxAgeMs, futureSkewToleranceMs) {
  if (operation.heartbeatAt === null) return { fresh: null, futureSkew: false };
  const heartbeatMs = parseTime(operation.heartbeatAt);
  if (heartbeatMs === null) return { fresh: null, futureSkew: false };
  if (heartbeatMs > nowMs + futureSkewToleranceMs) return { fresh: null, futureSkew: true };
  return { fresh: nowMs - heartbeatMs <= heartbeatMaxAgeMs, futureSkew: false };
}

function deadlineState(operation, nowMs) {
  if (operation.deadlineAt === null) return null;
  const deadlineMs = parseTime(operation.deadlineAt);
  if (deadlineMs === null) return null;
  return deadlineMs < nowMs;
}

export function assessOperationLiveness({
  operation,
  runtimeOwner = null,
  ownerObservation = null,
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

  if (runtimeOwner === null) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "RUNTIME_OWNER_MISSING");
  }
  if (!validateRuntimeOwnerV2(runtimeOwner).valid) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "RUNTIME_OWNER_INVALID");
  }
  if (runtimeOwner.operationId !== operation.operationId) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_OPERATION_MISMATCH");
  }
  if (operation.runtimeOwnerRef !== runtimeOwner.runtimeOwnerId) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_REFERENCE_MISMATCH");
  }

  if (ownerObservation === null) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_OBSERVATION_MISSING");
  }
  if (!validateOwnerObservationV2(ownerObservation).valid) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_OBSERVATION_INVALID");
  }
  if (ownerObservation.runtimeOwnerId !== runtimeOwner.runtimeOwnerId) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_OBSERVATION_MISMATCH");
  }

  const observationMs = parseTime(ownerObservation.observedAt);
  if (observationMs > nowMs + futureSkewToleranceMs) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_OBSERVATION_FUTURE_SKEW", {
      ownerStatus: ownerObservation.status,
    });
  }
  if (nowMs - observationMs > ownerObservationMaxAgeMs) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_OBSERVATION_STALE", {
      ownerStatus: ownerObservation.status,
    });
  }

  if (ownerObservation.status === "MATCH"
    && ownerObservation.observedProcessIdentity !== runtimeOwner.process.startIdentity) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_OBSERVATION_INCONSISTENT", {
      ownerStatus: ownerObservation.status,
    });
  }
  if (ownerObservation.status === "MISMATCH"
    && ownerObservation.observedProcessIdentity === runtimeOwner.process.startIdentity) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_OBSERVATION_INCONSISTENT", {
      ownerStatus: ownerObservation.status,
    });
  }

  const heartbeat = heartbeatState(operation, nowMs, heartbeatMaxAgeMs, futureSkewToleranceMs);
  const deadlineExpired = deadlineState(operation, nowMs);
  const evidence = {
    ownerStatus: ownerObservation.status,
    heartbeatFresh: heartbeat.fresh,
    deadlineExpired,
  };

  if (heartbeat.futureSkew) {
    return assessment(operation.operationId, observedAt, "UNKNOWN", "HEARTBEAT_FUTURE_SKEW", evidence);
  }

  switch (ownerObservation.status) {
    case "UNAVAILABLE":
      return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_OBSERVATION_UNAVAILABLE", evidence);

    case "MATCH":
      if (deadlineExpired === true) {
        return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_MATCH_DEADLINE_EXPIRED", evidence);
      }
      if (heartbeat.fresh !== true) {
        return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_MATCH_HEARTBEAT_STALE", evidence);
      }
      return assessment(operation.operationId, observedAt, "LIVE", "OWNER_MATCH_HEARTBEAT_FRESH", evidence);

    case "ABSENT":
      if (heartbeat.fresh === true) {
        return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_ABSENT_HEARTBEAT_FRESH", evidence);
      }
      if (heartbeat.fresh === false && deadlineExpired === true) {
        return assessment(operation.operationId, observedAt, "STALE_RECOVERABLE", "OWNER_ABSENT_BOUNDED_STALE", evidence);
      }
      return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_ABSENT_UNBOUNDED", evidence);

    case "MISMATCH":
      if (heartbeat.fresh === true) {
        return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_MISMATCH_HEARTBEAT_FRESH", evidence);
      }
      if (heartbeat.fresh === false && deadlineExpired === true) {
        return assessment(operation.operationId, observedAt, "STALE_RECOVERABLE", "OWNER_MISMATCH_BOUNDED_STALE", evidence);
      }
      return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_MISMATCH_UNBOUNDED", evidence);

    default:
      return assessment(operation.operationId, observedAt, "UNKNOWN", "OWNER_OBSERVATION_UNAVAILABLE", evidence);
  }
}
