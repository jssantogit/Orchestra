import { assertDelegationRequest } from "../domain/delegation.mjs";
import { WORKER_REPORT_SCHEMA } from "./policy.mjs";

const REQUIRED_FORBIDDEN_PATHS = Object.freeze([
  ".orchestra/state/**",
  ".git/**",
]);

function normalizeScopePath(value) {
  if (typeof value !== "string") return value;
  let normalized = value.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/{2,}/g, "/");
  return normalized;
}

function isCanonicalStatePath(value) {
  const normalized = normalizeScopePath(value);
  return typeof normalized === "string"
    && (normalized === ".orchestra/state" || normalized.startsWith(".orchestra/state/"));
}

function normalizedUnique(values) {
  return [...new Set(values.map(normalizeScopePath))];
}

function copyAnchor(anchor) {
  return { ...anchor };
}

export function buildWorkerEnvelope(request) {
  assertDelegationRequest(request);

  const packet = request.packet;
  const allowedAreas = normalizedUnique(packet.scope.allowedAreas)
    .filter((entry) => !isCanonicalStatePath(entry));
  const forbidden = normalizedUnique([
    ...packet.scope.forbidden,
    ...REQUIRED_FORBIDDEN_PATHS,
  ]);

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
      allowedAreas,
      forbidden,
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
