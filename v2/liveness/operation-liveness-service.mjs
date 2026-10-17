import { assessOperationLiveness } from "./assess.mjs";
import { assessProviderEventLiveness } from "./provider-event-liveness.mjs";

function unknown(operation, observedAt, reason) {
  return {
    schema: "orchestra.liveness-assessment.v2",
    operationId: operation?.operationId ?? null,
    observedAt,
    liveness: "UNKNOWN",
    reason,
    evidence: {
      ownerStatus: null,
      heartbeatFresh: null,
      deadlineExpired: null,
    },
  };
}

export function createOperationLivenessService({
  runtimeOwnerStore,
  ownerProbe,
  providerEventProbe,
  now = () => new Date().toISOString(),
  heartbeatMaxAgeMs = 30_000,
  ownerObservationMaxAgeMs = 15_000,
  futureSkewToleranceMs = 5_000,
} = {}) {
  if (typeof runtimeOwnerStore?.read !== "function") throw new TypeError("runtimeOwnerStore.read is required");
  if (typeof ownerProbe?.observe !== "function" && typeof providerEventProbe?.observe !== "function") {
    throw new TypeError("ownerProbe.observe is required");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  return Object.freeze({
    async assess(operation) {
      const observedAt = now();

      if (operation?.liveness === "TERMINAL") {
        return assessOperationLiveness({
          operation,
          runtimeOwner: null,
          ownerObservation: null,
          now: observedAt,
          heartbeatMaxAgeMs,
          ownerObservationMaxAgeMs,
          futureSkewToleranceMs,
        });
      }

      if (typeof operation?.runtimeOwnerRef !== "string" || operation.runtimeOwnerRef.trim().length === 0) {
        return assessOperationLiveness({
          operation,
          runtimeOwner: null,
          ownerObservation: null,
          now: observedAt,
          heartbeatMaxAgeMs,
          ownerObservationMaxAgeMs,
          futureSkewToleranceMs,
        });
      }

      let runtimeOwner;
      try {
        runtimeOwner = await runtimeOwnerStore.read(operation.runtimeOwnerRef);
      } catch {
        return unknown(operation, observedAt, "RUNTIME_OWNER_STORE_ERROR");
      }

      if (runtimeOwner === null) {
        return assessOperationLiveness({
          operation,
          runtimeOwner: null,
          ownerObservation: null,
          now: observedAt,
          heartbeatMaxAgeMs,
          ownerObservationMaxAgeMs,
          futureSkewToleranceMs,
        });
      }

      if (runtimeOwner.kind === "PROVIDER_EVENT") {
        if (typeof providerEventProbe?.observe !== "function") {
          return assessProviderEventLiveness({
            operation,
            runtimeOwner,
            providerEventObservation: null,
            now: observedAt,
            heartbeatMaxAgeMs,
            ownerObservationMaxAgeMs,
            futureSkewToleranceMs,
          });
        }
        let providerEventObservation;
        try {
          providerEventObservation = await providerEventProbe.observe(runtimeOwner);
        } catch {
          providerEventObservation = null;
        }
        return assessProviderEventLiveness({
          operation,
          runtimeOwner,
          providerEventObservation,
          now: observedAt,
          heartbeatMaxAgeMs,
          ownerObservationMaxAgeMs,
          futureSkewToleranceMs,
        });
      }

      if (typeof ownerProbe?.observe !== "function") {
        throw new TypeError("ownerProbe.observe is required for LOCAL_PROCESS owners");
      }

      let ownerObservation;
      try {
        ownerObservation = await ownerProbe.observe(runtimeOwner);
      } catch {
        return unknown(operation, observedAt, "OWNER_PROBE_FAILED");
      }

      return assessOperationLiveness({
        operation,
        runtimeOwner,
        ownerObservation,
        now: observedAt,
        heartbeatMaxAgeMs,
        ownerObservationMaxAgeMs,
        futureSkewToleranceMs,
      });
    },
  });
}
