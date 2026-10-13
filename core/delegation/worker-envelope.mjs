import { assertDelegationRequest } from "../domain/delegation.mjs";
import { WORKER_REPORT_SCHEMA } from "./policy.mjs";

function isCanonicalStatePath(value) {
  return typeof value === "string"
    && (value === ".orchestra/state" || value.startsWith(".orchestra/state/"));
}

function copyAnchor(anchor) {
  return { ...anchor };
}

export function buildWorkerEnvelope(request) {
  assertDelegationRequest(request);

  const packet = request.packet;
  return {
    objective: packet.goal,
    logicalRole: request.target.logicalRole,
    purpose: request.purpose,
    context: {
      direction: {
        ...(packet.direction.cause ? { cause: packet.direction.cause } : {}),
        change: packet.direction.change,
        preserve: [...packet.direction.preserve],
      },
      anchors: packet.anchors.map(copyAnchor),
      discovery: packet.permissions.discovery,
      tests: packet.permissions.tests,
    },
    scope: {
      allowedAreas: packet.scope.allowedAreas.filter((entry) => !isCanonicalStatePath(entry)),
      forbidden: packet.scope.forbidden.filter((entry) => !isCanonicalStatePath(entry)),
    },
    validation: [...packet.validation],
    capabilities: [...request.authority.capabilities],
    prohibitions: {
      mutation: "FORBIDDEN",
      network: "FORBIDDEN",
      delegation: "FORBIDDEN",
    },
    outputContract: {
      schema: WORKER_REPORT_SCHEMA.$id,
      format: "JSON",
      additionalProperties: false,
    },
    limits: {
      timeoutMs: request.limits.timeoutMs,
      maxOutputBytes: request.limits.maxOutputBytes,
    },
  };
}
