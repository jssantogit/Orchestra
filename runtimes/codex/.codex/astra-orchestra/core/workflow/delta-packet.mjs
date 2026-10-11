import { validateCandidate } from '../domain/candidate.mjs';
import { DISCOVERY_MODES, validateImplementationPacket } from '../domain/implementation-packet.mjs';

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneDirection(direction = {}) {
  return {
    ...direction,
    preserve: Array.isArray(direction.preserve) ? [...direction.preserve] : direction.preserve,
  };
}

function validateShape(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: [{ path: '/', message: 'must be object' }] };
  }
  if (value.schema !== 'orchestra.delta-packet.v1') errors.push({ path: '/schema', message: 'invalid schema' });
  for (const key of ['taskId', 'parentCandidateId', 'workspaceId']) {
    if (!nonEmpty(value[key])) errors.push({ path: `/${key}`, message: 'must be non-empty string' });
  }
  if (!Number.isInteger(value.baseCandidateGeneration) || value.baseCandidateGeneration < 0) {
    errors.push({ path: '/baseCandidateGeneration', message: 'must be non-negative integer' });
  }
  if (value.candidateGeneration !== value.baseCandidateGeneration + 1) {
    errors.push({ path: '/candidateGeneration', message: 'must increment base generation by one' });
  }
  if (!value.direction || !nonEmpty(value.direction.change) || !Array.isArray(value.direction.preserve)) {
    errors.push({ path: '/direction', message: 'must preserve resolved direction' });
  }
  if (![DISCOVERY_MODES.NONE, DISCOVERY_MODES.DIRECTED].includes(value.discovery)) {
    errors.push({ path: '/discovery', message: 'delta discovery must be NONE or DIRECTED' });
  }
  if (!value.confirmedFinding || !nonEmpty(value.confirmedFinding.code) || !nonEmpty(value.confirmedFinding.location) || !nonEmpty(value.confirmedFinding.issue)) {
    errors.push({ path: '/confirmedFinding', message: 'must contain one confirmed finding' });
  }
  if (!Array.isArray(value.correctionArea?.allowedAreas) || value.correctionArea.allowedAreas.length === 0 || value.correctionArea.allowedAreas.some((area) => !nonEmpty(area))) {
    errors.push({ path: '/correctionArea/allowedAreas', message: 'must contain correction scope' });
  }
  if (!Array.isArray(value.revalidation) || value.revalidation.length === 0 || value.revalidation.some((item) => !nonEmpty(item))) {
    errors.push({ path: '/revalidation', message: 'must contain revalidation steps' });
  }
  return { valid: errors.length === 0, errors };
}

export function validateDeltaPacket(value) {
  return validateShape(value);
}

export function createDeltaPacket({
  originalPacket,
  candidate,
  confirmedFinding,
  correctionArea,
  revalidation,
} = {}) {
  if (!validateImplementationPacket(originalPacket).valid) {
    throw new Error('ORCHESTRA_DELTA_PACKET_INVALID original implementation packet');
  }
  if (!validateCandidate(candidate).valid) {
    throw new Error('ORCHESTRA_DELTA_PACKET_INVALID candidate lineage is not canonical');
  }
  if (candidate.taskId !== originalPacket.taskId || candidate.generation !== originalPacket.candidateGeneration) {
    throw new Error('ORCHESTRA_DELTA_PACKET_INVALID candidate lineage does not match implementation packet');
  }

  const correctionAreas = Array.isArray(correctionArea?.allowedAreas) ? correctionArea.allowedAreas : [];
  const allowed = new Set(originalPacket.scope?.allowedAreas || []);
  const forbidden = new Set(originalPacket.scope?.forbidden || []);
  if (correctionAreas.length === 0 || correctionAreas.some((area) => !allowed.has(area) || forbidden.has(area))) {
    throw new Error('ORCHESTRA_DELTA_PACKET_INVALID correction area widens original scope');
  }

  const packet = {
    schema: 'orchestra.delta-packet.v1',
    taskId: originalPacket.taskId,
    parentCandidateId: candidate.candidateId,
    workspaceId: candidate.workspaceId,
    parentHeadSha: candidate.headSha ?? null,
    baseCandidateGeneration: candidate.generation,
    candidateGeneration: candidate.generation + 1,
    direction: cloneDirection(originalPacket.direction),
    discovery: originalPacket.permissions?.discovery === DISCOVERY_MODES.NONE
      ? DISCOVERY_MODES.NONE
      : DISCOVERY_MODES.DIRECTED,
    confirmedFinding: { ...confirmedFinding },
    correctionArea: { allowedAreas: [...correctionAreas] },
    revalidation: Array.isArray(revalidation) ? [...revalidation] : revalidation,
  };

  const validation = validateDeltaPacket(packet);
  if (!validation.valid) {
    const error = new Error('ORCHESTRA_DELTA_PACKET_INVALID delta packet');
    error.errors = validation.errors;
    throw error;
  }
  return packet;
}
