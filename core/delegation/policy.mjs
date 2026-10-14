import { validateDelegationRequest } from "../domain/delegation.mjs";

const REQUIRED_CAPABILITIES = Object.freeze(["LOCAL_READ", "PROCESS_EXEC"]);
const REQUIRED_CAPABILITY_SET = new Set(REQUIRED_CAPABILITIES);

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

function hasExactWorkerCapabilities(authority) {
  if (!authority || !Array.isArray(authority.capabilities)) return false;
  if (authority.capabilities.length !== REQUIRED_CAPABILITIES.length) return false;
  const capabilities = new Set(authority.capabilities);
  return capabilities.size === REQUIRED_CAPABILITIES.length
    && REQUIRED_CAPABILITIES.every((capability) => capabilities.has(capability))
    && [...capabilities].every((capability) => REQUIRED_CAPABILITY_SET.has(capability));
}

function capabilityBoundaryIsValid(request) {
  return hasExactWorkerCapabilities(request?.authority)
    && request.authority.mutation === "FORBIDDEN"
    && request.authority.network === "FORBIDDEN"
    && request.authority.mayDelegate === false
    && request?.limits?.delegationDepth === 1;
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
