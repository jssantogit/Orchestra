import { validateCandidate } from "../domain/candidate.mjs";
import { DISCOVERY_MODES, validateImplementationPacket } from "../domain/implementation-packet.mjs";
import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "delta-packet.v1.schema.json";

function cloneDirection(direction = {}) {
  return {
    ...direction,
    preserve: Array.isArray(direction.preserve) ? [...direction.preserve] : direction.preserve,
  };
}

function cloneFinding(finding = {}) {
  return { ...finding };
}

function cloneCorrectionArea(area = {}) {
  return {
    ...area,
    allowedAreas: Array.isArray(area.allowedAreas) ? [...area.allowedAreas] : area.allowedAreas,
  };
}

export function validateDeltaPacket(value) {
  return validateSchema(SCHEMA, value);
}

export function createDeltaPacket({
  originalPacket,
  candidate,
  confirmedFinding,
  correctionArea,
  revalidation,
} = {}) {
  const packetValidation = validateImplementationPacket(originalPacket);
  if (!packetValidation.valid) {
    throw new Error("ORCHESTRA_DELTA_PACKET_INVALID original implementation packet");
  }

  const candidateValidation = validateCandidate(candidate);
  if (!candidateValidation.valid) {
    throw new Error("ORCHESTRA_DELTA_PACKET_INVALID candidate lineage is not canonical");
  }

  if (
    candidate.taskId !== originalPacket.taskId ||
    candidate.generation !== originalPacket.candidateGeneration
  ) {
    throw new Error("ORCHESTRA_DELTA_PACKET_INVALID candidate lineage does not match implementation packet");
  }

  const correctionAreas = Array.isArray(correctionArea?.allowedAreas)
    ? correctionArea.allowedAreas
    : [];
  const originalAllowed = new Set(originalPacket.scope?.allowedAreas || []);
  const originalForbidden = new Set(originalPacket.scope?.forbidden || []);
  if (
    correctionAreas.some((area) => !originalAllowed.has(area) || originalForbidden.has(area))
  ) {
    throw new Error("ORCHESTRA_DELTA_PACKET_INVALID correction area widens original scope");
  }

  const packet = {
    schema: "orchestra.delta-packet.v1",
    taskId: originalPacket.taskId,
    parentCandidateIdentity: candidate.identity,
    baseCandidateGeneration: candidate.generation,
    candidateGeneration: candidate.generation + 1,
    direction: cloneDirection(originalPacket.direction),
    discovery: originalPacket.permissions?.discovery === DISCOVERY_MODES.NONE
      ? DISCOVERY_MODES.NONE
      : DISCOVERY_MODES.DIRECTED,
    confirmedFinding: cloneFinding(confirmedFinding),
    correctionArea: cloneCorrectionArea(correctionArea),
    revalidation: Array.isArray(revalidation) ? [...revalidation] : revalidation,
  };

  assertSchema(SCHEMA, packet);
  return packet;
}
