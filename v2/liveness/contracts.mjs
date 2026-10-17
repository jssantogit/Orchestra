const OWNER_KINDS = new Set(["LOCAL_PROCESS", "PROVIDER_EVENT"]);
const OWNER_STATUSES = new Set(["MATCH", "ABSENT", "MISMATCH", "UNAVAILABLE"]);
const ASSESSMENT_LIVENESS = new Set(["LIVE", "TERMINAL", "STALE_RECOVERABLE", "UNKNOWN"]);
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/i;

function ok() {
  return { valid: true, errors: [] };
}

function fail(message, path = "/") {
  return { valid: false, errors: [{ path, message }] };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBooleanOrNull(value) {
  return value === null || typeof value === "boolean";
}

export function validateRuntimeOwnerV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.runtime-owner.v2") {
    return fail("invalid runtime owner schema");
  }

  const commonAllowed = new Set([
    "schema",
    "runtimeOwnerId",
    "operationId",
    "kind",
    "registeredAt",
  ]);
  if (!isNonEmptyString(value.runtimeOwnerId) || !isNonEmptyString(value.operationId)) {
    return fail("runtime owner identity required");
  }
  if (!OWNER_KINDS.has(value.kind)) return fail("unsupported runtime owner kind");
  if (!isTimestamp(value.registeredAt)) return fail("invalid runtime owner registration timestamp");

  if (value.kind === "LOCAL_PROCESS") {
    if (!hasOnlyKeys(value, new Set([...commonAllowed, "process", "proof"]))) {
      return fail("unknown runtime owner field");
    }
    if (!isRecord(value.process)) return fail("local process descriptor required", "/process");
    if (!hasOnlyKeys(value.process, new Set(["pid", "startIdentity"]))) {
      return fail("unknown local process field", "/process");
    }
    if (!Number.isInteger(value.process.pid) || value.process.pid <= 0) {
      return fail("positive process pid required", "/process/pid");
    }
    if (!isNonEmptyString(value.process.startIdentity)) {
      return fail("process birth identity required", "/process/startIdentity");
    }

    if (!isRecord(value.proof) || !hasOnlyKeys(value.proof, new Set(["tokenHash"]))) {
      return fail("runtime owner proof required", "/proof");
    }
    if (!isNonEmptyString(value.proof.tokenHash) || !SHA256_DIGEST.test(value.proof.tokenHash)) {
      return fail("runtime owner proof must be a sha256 digest", "/proof/tokenHash");
    }
  } else {
    const providerAllowed = new Set([...commonAllowed, "correlationRef", "startedAt", "lastProviderEventAt", "deadlineAt"]);
    if (!hasOnlyKeys(value, providerAllowed)) return fail("unknown provider-event owner field");
    if (!isNonEmptyString(value.correlationRef) || !SHA256_DIGEST.test(value.correlationRef)) {
      return fail("provider correlation ref must be a sha256 digest", "/correlationRef");
    }
    for (const key of ["startedAt", "lastProviderEventAt", "deadlineAt"]) {
      if (!isTimestamp(value[key])) return fail(`invalid provider-event ${key}`, `/${key}`);
    }
  }

  return ok();
}

export function validateProviderEventObservationV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.provider-event-observation.v2") {
    return fail("invalid provider-event observation schema");
  }
  const allowed = new Set(["schema", "runtimeOwnerId", "correlationRef", "status", "eventAt", "observedAt"]);
  if (!hasOnlyKeys(value, allowed)) return fail("unknown provider-event observation field");
  if (!isNonEmptyString(value.runtimeOwnerId)) return fail("runtime owner id required");
  if (!isNonEmptyString(value.correlationRef) || !SHA256_DIGEST.test(value.correlationRef)) {
    return fail("provider correlation ref must be a sha256 digest", "/correlationRef");
  }
  if (value.status !== "POSITIVE" && value.status !== "CONTRADICTORY") {
    return fail("invalid provider-event status", "/status");
  }
  if (!isTimestamp(value.eventAt)) return fail("invalid provider-event timestamp", "/eventAt");
  if (!isTimestamp(value.observedAt)) return fail("invalid provider-event observation timestamp", "/observedAt");
  return ok();
}

export function validateOwnerObservationV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.owner-observation.v2") {
    return fail("invalid owner observation schema");
  }

  const allowed = new Set([
    "schema",
    "runtimeOwnerId",
    "observedAt",
    "status",
    "observedProcessIdentity",
  ]);
  if (!hasOnlyKeys(value, allowed)) return fail("unknown owner observation field");
  if (!isNonEmptyString(value.runtimeOwnerId)) return fail("runtime owner id required");
  if (!isTimestamp(value.observedAt)) return fail("invalid owner observation timestamp");
  if (!OWNER_STATUSES.has(value.status)) return fail("invalid owner observation status");

  if (value.status === "MATCH" || value.status === "MISMATCH") {
    if (!isNonEmptyString(value.observedProcessIdentity)) {
      return fail("observed process identity required for process match/mismatch");
    }
  } else if (value.observedProcessIdentity !== null) {
    return fail("absent/unavailable observation cannot claim process identity");
  }

  return ok();
}

export function validateLivenessAssessmentV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.liveness-assessment.v2") {
    return fail("invalid liveness assessment schema");
  }

  const allowed = new Set([
    "schema",
    "operationId",
    "observedAt",
    "liveness",
    "reason",
    "evidence",
  ]);
  if (!hasOnlyKeys(value, allowed)) return fail("unknown liveness assessment field");
  if (!isNonEmptyString(value.operationId)) return fail("operation id required");
  if (!isTimestamp(value.observedAt)) return fail("invalid liveness assessment timestamp");
  if (!ASSESSMENT_LIVENESS.has(value.liveness)) return fail("invalid assessed liveness");
  if (!isNonEmptyString(value.reason)) return fail("liveness reason required");

  if (!isRecord(value.evidence)
    || !hasOnlyKeys(value.evidence, new Set([
      "ownerStatus",
      "heartbeatFresh",
      "deadlineExpired",
      "providerEventFresh",
      "providerEventCorrelationMatched",
    ]))) {
    return fail("invalid liveness evidence", "/evidence");
  }
  if (value.evidence.ownerStatus !== null && !OWNER_STATUSES.has(value.evidence.ownerStatus)) {
    return fail("invalid liveness owner status", "/evidence/ownerStatus");
  }
  if (!isBooleanOrNull(value.evidence.heartbeatFresh)) {
    return fail("invalid heartbeat freshness", "/evidence/heartbeatFresh");
  }
  if (!isBooleanOrNull(value.evidence.deadlineExpired)) {
    return fail("invalid deadline expiry", "/evidence/deadlineExpired");
  }
  for (const key of ["providerEventFresh", "providerEventCorrelationMatched"]) {
    if (key in value.evidence && !isBooleanOrNull(value.evidence[key])) {
      return fail(`invalid ${key}`, `/evidence/${key}`);
    }
  }

  return ok();
}
