import { normalizeMutationScope } from "./mutation-scope.mjs";
import { validateDelegationRequest } from "../domain/delegation.mjs";

const REVIEW_CAPABILITIES = Object.freeze(["LOCAL_READ", "PROCESS_EXEC"]);
const IMPLEMENTATION_CAPABILITIES = Object.freeze(["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"]);

export const WORKER_REPORT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "orchestra.delegation-worker-report.v1",
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "evidenceRefs"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 8192 },
    findings: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 4096 },
    },
    evidenceRefs: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
});

function hasExactCapabilities(authority, requiredCapabilities) {
  if (!authority || !Array.isArray(authority.capabilities)) return false;
  if (authority.capabilities.length !== requiredCapabilities.length) return false;
  const capabilities = new Set(authority.capabilities);
  if (capabilities.size !== requiredCapabilities.length) return false;
  return requiredCapabilities.every((capability) => capabilities.has(capability));
}

function v1BoundaryIsValid(request) {
  return hasExactCapabilities(request?.authority, REVIEW_CAPABILITIES)
    && request.authority.mutation === "FORBIDDEN"
    && request.authority.network === "FORBIDDEN"
    && request.authority.mayDelegate === false
    && request?.limits?.delegationDepth === 1;
}

function v2BoundaryIsValid(request) {
  if (!(hasExactCapabilities(request?.authority, IMPLEMENTATION_CAPABILITIES)
    && request.authority.mutation === "WORKSPACE_ONLY"
    && request.authority.network === "FORBIDDEN"
    && request.authority.mayDelegate === false
    && request?.limits?.delegationDepth === 1
    && request?.target?.logicalRole === "IMPLEMENTER"
    && request?.purpose === "IMPLEMENTATION"
    && request?.workspace?.isolation === "EPHEMERAL_CLONE")) return false;

  try {
    normalizeMutationScope(request.workspace.mutationScope);
    return true;
  } catch {
    return false;
  }
}

function capabilityBoundaryIsValid(request) {
  if (request?.schema === "orchestra.delegation-request.v1") return v1BoundaryIsValid(request);
  if (request?.schema === "orchestra.delegation-request.v2") return v2BoundaryIsValid(request);
  return false;
}

export function authorizeDelegationRequest(request, { sourceProvider, sourceFingerprint } = {}) {
  if (!capabilityBoundaryIsValid(request)) {
    return { allowed: false, reason: "CAPABILITY_DENIED" };
  }

  const validation = validateDelegationRequest(request);
  if (!validation.valid) {
    return { allowed: false, reason: "CAPABILITY_DENIED" };
  }

  if (!sourceProvider
      || request.source.provider !== sourceProvider
      || request.target.provider === sourceProvider) {
    return { allowed: false, reason: "CAPABILITY_DENIED" };
  }

  if (!sourceFingerprint || request.workspace.sourceFingerprint !== sourceFingerprint) {
    return { allowed: false, reason: "WORKSPACE_PREP_FAILED" };
  }

  return { allowed: true, reason: null };
}
