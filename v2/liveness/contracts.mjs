const OWNER_KINDS = new Set(["LOCAL_PROCESS"]);
const OWNER_STATUSES = new Set(["MATCH", "ABSENT", "MISMATCH", "UNAVAILABLE"]);
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

export function validateRuntimeOwnerV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.runtime-owner.v2") {
    return fail("invalid runtime owner schema");
  }

  const allowed = new Set([
    "schema",
    "runtimeOwnerId",
    "operationId",
    "kind",
    "process",
    "proof",
    "registeredAt",
  ]);
  if (!hasOnlyKeys(value, allowed)) return fail("unknown runtime owner field");
  if (!isNonEmptyString(value.runtimeOwnerId) || !isNonEmptyString(value.operationId)) {
    return fail("runtime owner identity required");
  }
  if (!OWNER_KINDS.has(value.kind)) return fail("unsupported runtime owner kind");
  if (!isTimestamp(value.registeredAt)) return fail("invalid runtime owner registration timestamp");

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
