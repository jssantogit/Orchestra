export const MIGRATION_DISPOSITIONS = Object.freeze([
  "CLEAN_IMPORT",
  "RECOVERABLE_IMPORT",
  "PRIVATE_ARCHIVE",
  "UNSUPPORTED_BLOCKED",
]);

const SUPPORTED_DURABLE_SCHEMAS = new Set([
  "orchestra.candidate.v1",
  "orchestra.evidence.v1",
  "orchestra.work-continuation.v1",
  "orchestra.work-lease.v1",
]);
const SUPPORTED_PARALLEL_GROUP_SCHEMA = "orchestra.parallel-group-state.v1";
const MALFORMED_INTEGRITY = new Set(["MALFORMED_JSON", "MALFORMED_SCHEMA"]);
const SUPPORTED_RUNTIME_VERSIONS = new Set(["v1.4.2", "1.4.2", "v1.4.3", "1.4.3"]);
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/i;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function blocked(code, details = {}) {
  return Object.freeze({
    ok: true,
    disposition: "UNSUPPORTED_BLOCKED",
    authorityClaim: false,
    blocksActivation: true,
    diagnostic: Object.freeze({ code, ...details }),
    reconciliation: Object.freeze({
      eligible: false,
      liveness: "UNKNOWN",
      successClaim: false,
      cleanupAuthorized: false,
      operationImportEligible: false,
    }),
  });
}

function clean(entry) {
  return Object.freeze({
    ok: true,
    disposition: "CLEAN_IMPORT",
    authorityClaim: false,
    blocksActivation: false,
    diagnostic: null,
    importFact: Object.freeze({
      path: entry.path,
      schema: entry.schema,
      version: entry.version,
      digest: entry.digest,
    }),
    reconciliation: Object.freeze({
      eligible: false,
      liveness: "UNKNOWN",
      successClaim: false,
      cleanupAuthorized: false,
      operationImportEligible: false,
    }),
  });
}

function privateArchive(entry) {
  return Object.freeze({
    ok: true,
    disposition: "PRIVATE_ARCHIVE",
    authorityClaim: false,
    blocksActivation: false,
    diagnostic: null,
    archive: Object.freeze({
      path: entry.path,
      digest: entry.digest,
      private: true,
    }),
    reconciliation: Object.freeze({
      eligible: false,
      liveness: "UNKNOWN",
      successClaim: false,
      cleanupAuthorized: false,
      operationImportEligible: false,
    }),
  });
}

function transientEvidence(facts) {
  return Object.freeze({
    persistedState: typeof facts.persistedState === "string" ? facts.persistedState : null,
    runtimeVersion: typeof facts.runtimeVersion === "string" ? facts.runtimeVersion : null,
    ownerProcessProof: typeof facts.ownerProcessProof === "string" ? facts.ownerProcessProof : "UNKNOWN",
    survivingWorkspaces: Number.isInteger(facts.survivingWorkspaces) && facts.survivingWorkspaces >= 0
      ? facts.survivingWorkspaces
      : 0,
    canonicalPromotion: facts.canonicalPromotion === true,
  });
}

function workspaceIdentity(facts) {
  if (!Number.isInteger(facts.survivingWorkspaces) || facts.survivingWorkspaces < 0) return "UNKNOWN";
  if (facts.survivingWorkspaces === 0) return "NONE_OBSERVED";
  if (facts.survivingWorkspaces === 1) {
    if (facts.workspaceIdentityProven === true && nonEmptyString(facts.survivingWorkspaceRef)) {
      return "SINGLE_SURVIVOR_VERIFIED";
    }
    return "SINGLE_SURVIVOR_UNVERIFIED";
  }
  return "AMBIGUOUS";
}

function operationImportEligible(facts) {
  return facts.operationProvenanceComplete === true
    && facts.ownerProcessProof === "ABSENT"
    && facts.survivingWorkspaces === 1
    && facts.workspaceIdentityProven === true
    && nonEmptyString(facts.survivingWorkspaceRef)
    && nonEmptyString(facts.operationKind)
    && isTimestamp(facts.startedAt)
    && isTimestamp(facts.heartbeatAt)
    && isTimestamp(facts.deadlineAt)
    && isRecord(facts.ownerProcess)
    && Number.isInteger(facts.ownerProcess.pid)
    && facts.ownerProcess.pid > 0
    && nonEmptyString(facts.ownerProcess.startIdentity)
    && SHA256_DIGEST.test(facts.ownerProofTokenHash ?? "");
}

function recoverable(entry, facts, code = "LEGACY_TRANSIENT_REQUIRES_RECONCILIATION") {
  const evidence = transientEvidence(facts);
  const importEligible = operationImportEligible(facts);
  return Object.freeze({
    ok: true,
    disposition: "RECOVERABLE_IMPORT",
    authorityClaim: false,
    blocksActivation: false,
    diagnostic: Object.freeze({ code }),
    legacyEvidence: evidence,
    importFact: Object.freeze({
      path: entry.path,
      schema: entry.schema,
      version: entry.version,
      digest: entry.digest,
    }),
    reconciliation: Object.freeze({
      eligible: true,
      liveness: "UNKNOWN",
      successClaim: false,
      workspaceIdentity: workspaceIdentity(facts),
      cleanupAuthorized: false,
      canonicalPromotionClaim: evidence.canonicalPromotion,
      operationImportEligible: importEligible,
      actionRequired: importEligible ? "RECONCILE_IMPORTED_OPERATION" : "RECONCILE_LEGACY_TRANSIENT_STATE",
    }),
  });
}

function validInventoryEntry(entry) {
  return isRecord(entry)
    && typeof entry.path === "string"
    && typeof entry.category === "string"
    && typeof entry.digest === "string"
    && /^sha256:[0-9a-f]{64}$/.test(entry.digest)
    && typeof entry.integrity === "string"
    && typeof entry.dispositionBasis === "string"
    && typeof entry.private === "boolean";
}

function unsupportedVersion(entry) {
  return entry.version !== null
    && entry.version !== undefined
    && (!Number.isInteger(entry.version) || entry.version !== 1);
}

function supportedRuntime(facts) {
  if (facts.runtimeVersion === undefined || facts.runtimeVersion === null) return true;
  return typeof facts.runtimeVersion === "string" && SUPPORTED_RUNTIME_VERSIONS.has(facts.runtimeVersion);
}

export function classifyLegacyInventoryEntry({ entry, facts = {} } = {}) {
  if (!validInventoryEntry(entry) || !isRecord(facts)) {
    return blocked("LEGACY_INVENTORY_ENTRY_INVALID");
  }

  if (MALFORMED_INTEGRITY.has(entry.integrity) || entry.dispositionBasis === "UNSUPPORTED_OR_MALFORMED") {
    return blocked("LEGACY_RECORD_MALFORMED", { path: entry.path });
  }
  if (unsupportedVersion(entry)) {
    return blocked("LEGACY_SCHEMA_UNSUPPORTED", { schema: entry.schema ?? null, version: entry.version ?? null });
  }

  if (entry.private === true || entry.category === "PRIVATE_PROJECT_ARTIFACT" || entry.dispositionBasis === "PRIVATE_ARCHIVE") {
    return privateArchive(entry);
  }

  if (entry.category === "DURABLE_LEGACY_STATE") {
    if (!SUPPORTED_DURABLE_SCHEMAS.has(entry.schema) || entry.version !== 1) {
      return blocked("LEGACY_SCHEMA_UNSUPPORTED", { schema: entry.schema ?? null, version: entry.version ?? null });
    }
    if (facts.provenanceComplete !== true) {
      return blocked("LEGACY_PROVENANCE_INCOMPLETE", { path: entry.path });
    }
    if (facts.unresolvedTransientAuthority === true) {
      return recoverable(entry, facts, "LEGACY_TRANSIENT_AUTHORITY_UNRESOLVED");
    }
    return clean(entry);
  }

  if (entry.category === "TRANSIENT_PARALLEL_GROUP") {
    if (entry.schema !== SUPPORTED_PARALLEL_GROUP_SCHEMA || entry.version !== 1) {
      return blocked("LEGACY_SCHEMA_UNSUPPORTED", { schema: entry.schema ?? null, version: entry.version ?? null });
    }
    if (!supportedRuntime(facts)) {
      return blocked("LEGACY_RUNTIME_UNSUPPORTED", { runtimeVersion: facts.runtimeVersion ?? null });
    }
    return recoverable(entry, facts);
  }

  if (["TRANSIENT_LEGACY_STATE", "PROVIDER_LEGACY_STATE", "MANAGED_RUNTIME"].includes(entry.category)) {
    if (!supportedRuntime(facts)) {
      return blocked("LEGACY_RUNTIME_UNSUPPORTED", { runtimeVersion: facts.runtimeVersion ?? null });
    }
    return recoverable(entry, facts);
  }

  return blocked("LEGACY_CATEGORY_UNSUPPORTED", { category: entry.category });
}