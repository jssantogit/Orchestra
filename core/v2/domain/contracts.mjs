const V2_LIVENESS = new Set(["LIVE", "TERMINAL", "STALE_RECOVERABLE", "STALE_DIRTY", "UNKNOWN"]);
const ACTOR_SOURCES = new Set(["PROVIDER_FACT"]);
const EXPERIENCE_SCOPES = new Set(["PROJECT", "DOMAIN", "GLOBAL_CANDIDATE"]);

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

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

export function validateProjectV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.project.v2") return fail("invalid project schema");
  if (!isNonEmptyString(value.projectId) || !isNonEmptyString(value.lineageId)) return fail("project identity required");
  if (!isRecord(value.workspace) || !isNonEmptyString(value.workspace.canonicalRoot) || value.workspace.vcs !== "git") return fail("invalid workspace");
  if (!isRecord(value.runtime) || !isNonEmptyString(value.runtime.pinnedImage) || !isNonNegativeInteger(value.runtime.instructionEpoch)) return fail("invalid runtime pin");
  if (!isRecord(value.trust) || !isNonEmptyString(value.trust.mode)) return fail("invalid trust mode");
  return ok();
}

export function validateActorProvenanceV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.actor-provenance.v2") return fail("invalid actor provenance schema");
  const allowed = new Set(["schema", "provider", "subjectHash", "source", "observedAt"]);
  if (!hasOnlyKeys(value, allowed)) return fail("raw or unknown actor identity field is not allowed");
  if (!isNonEmptyString(value.provider) || !isNonEmptyString(value.subjectHash)) return fail("actor identity required");
  if (!ACTOR_SOURCES.has(value.source)) return fail("actor source must be factual provider provenance");
  if (!isTimestamp(value.observedAt)) return fail("invalid actor observation timestamp");
  return ok();
}

export function validateWorkUnitV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.work-unit.v2") return fail("invalid work unit schema");
  for (const key of ["workId", "projectId", "taskId", "runtimeImage", "state"]) {
    if (!isNonEmptyString(value[key])) return fail(`${key} required`);
  }
  if (!isNonNegativeInteger(value.generation) || !isNonNegativeInteger(value.instructionEpoch)) return fail("invalid work generation or instruction epoch");
  if (!Array.isArray(value.evidenceRefs) || !Array.isArray(value.blockers)) return fail("invalid work references");
  for (const key of ["scopeRef", "directionRef", "candidateRef", "continuationRef"]) {
    if (value[key] !== null && !isNonEmptyString(value[key])) return fail(`invalid ${key}`);
  }
  return ok();
}

export function validateOperationV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.operation.v2") return fail("invalid operation schema");
  for (const key of ["operationId", "projectId", "workId", "kind", "actorRef", "workflowState"]) {
    if (!isNonEmptyString(value[key])) return fail(`${key} required`);
  }
  if (!isNonNegativeInteger(value.generation)) return fail("invalid operation generation");
  if (!Array.isArray(value.capabilities) || value.capabilities.some((entry) => !isNonEmptyString(entry))) return fail("invalid capabilities");
  if (!V2_LIVENESS.has(value.liveness)) return fail("invalid liveness");
  if (!isTimestamp(value.startedAt)) return fail("invalid startedAt");
  for (const key of ["heartbeatAt", "deadlineAt"]) {
    if (value[key] !== null && !isTimestamp(value[key])) return fail(`invalid ${key}`);
  }
  for (const key of ["runtimeOwnerRef", "workspaceRef", "resultRef"]) {
    if (value[key] !== null && !isNonEmptyString(value[key])) return fail(`invalid ${key}`);
  }
  return ok();
}

export function validateRuntimeImageRefV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.runtime-image-ref.v2") return fail("invalid runtime image schema");
  if (!isNonEmptyString(value.version) || !isNonEmptyString(value.contentId) || !isNonEmptyString(value.contractVersion)) return fail("runtime image identity required");
  if (!isNonNegativeInteger(value.instructionEpochBase)) return fail("invalid instruction epoch base");
  return ok();
}

export function validateExperienceV2(value) {
  if (!isRecord(value) || value.schema !== "orchestra.experience.v2") return fail("invalid experience schema");
  if (!isNonEmptyString(value.experienceId) || !isNonEmptyString(value.category)) return fail("experience identity required");
  if (!isRecord(value.facts) || !isRecord(value.outcome) || !isRecord(value.generalization) || !isRecord(value.privacy)) return fail("experience sections required");
  if (!EXPERIENCE_SCOPES.has(value.generalization.scope) || !isNonNegativeInteger(value.generalization.projectLineageCount)) return fail("invalid experience generalization");
  if (!isNonEmptyString(value.privacy.projectionVersion) || value.privacy.containsRawProjectContent !== false) return fail("experience privacy projection invalid");
  return ok();
}
