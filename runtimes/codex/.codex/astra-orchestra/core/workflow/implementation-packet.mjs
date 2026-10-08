import {
  assertImplementationPacket,
  validateImplementationPacket,
} from "../domain/implementation-packet.mjs";

const UNRESOLVED_DIRECTION_PATTERNS = Object.freeze([
  /^\s*(?:find|locate|identify)\s+(?:the\s+)?bug\b/i,
  /\bfigure\s+out\b/i,
  /\binvestigat(?:e|ion)\b/i,
  /\bdetermine\s+(?:the\s+)?(?:cause|change|fix)\b/i,
  /\b(?:tbd|unknown|to be determined)\b/i,
]);

function containsUnresolvedDirection(value) {
  if (typeof value !== "string") return true;
  const normalized = value.trim();
  if (!normalized) return true;
  return UNRESOLVED_DIRECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function cloneArray(value) {
  return Array.isArray(value) ? value.map((item) => (
    item && typeof item === "object" ? { ...item } : item
  )) : value;
}

export function buildImplementationPacket({
  taskId,
  candidateGeneration,
  goal,
  direction,
  anchors,
  scope,
  permissions,
  validation,
  failurePolicy,
} = {}) {
  const packet = {
    schema: "orchestra.implementation-packet.v1",
    taskId,
    candidateGeneration,
    goal,
    direction: direction && typeof direction === "object"
      ? { ...direction, preserve: cloneArray(direction.preserve) }
      : direction,
    anchors: cloneArray(anchors),
    scope: scope && typeof scope === "object"
      ? { ...scope, allowedAreas: cloneArray(scope.allowedAreas), forbidden: cloneArray(scope.forbidden) }
      : scope,
    permissions: permissions && typeof permissions === "object"
      ? { ...permissions, sideEffects: cloneArray(permissions.sideEffects) }
      : permissions,
    validation: cloneArray(validation),
    failurePolicy: failurePolicy && typeof failurePolicy === "object" ? { ...failurePolicy } : failurePolicy,
  };

  assertImplementationPacket(packet);
  return packet;
}

export function assessImplementationReadiness(packet) {
  const validationResult = validateImplementationPacket(packet);
  if (!validationResult.valid) {
    return Object.freeze({ ready: false, reason: "PACKET_INSUFFICIENT" });
  }

  const direction = packet.direction || {};
  const insufficient = (
    typeof packet.goal !== "string" || !packet.goal.trim() ||
    containsUnresolvedDirection(direction.cause) ||
    containsUnresolvedDirection(direction.change) ||
    !packet.scope?.allowedAreas?.length ||
    !packet.validation?.length
  );

  if (insufficient) {
    return Object.freeze({ ready: false, reason: "PACKET_INSUFFICIENT" });
  }

  return Object.freeze({ ready: true, reason: "IMPLEMENTATION_READY" });
}
