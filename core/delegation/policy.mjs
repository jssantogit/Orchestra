import { validateDelegationRequest } from "../domain/delegation.mjs";

export const V1_DELEGATION_CAPABILITIES = Object.freeze(["LOCAL_READ", "PROCESS_EXEC"]);

function denied(reason) {
  return { allowed: false, reason };
}

export function authorizeDelegationRequest(request, { sourceProvider, sourceFingerprint } = {}) {
  const validation = validateDelegationRequest(request);
  if (!validation.valid) return denied("INVALID_DELEGATION_REQUEST");

  if (request.source.provider !== sourceProvider) {
    return denied("SOURCE_PROVIDER_MISMATCH");
  }

  if (request.workspace.sourceFingerprint !== sourceFingerprint) {
    return denied("SOURCE_FINGERPRINT_MISMATCH");
  }

  return { allowed: true, reason: "AUTHORIZED" };
}
