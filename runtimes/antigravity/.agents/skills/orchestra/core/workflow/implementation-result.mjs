export const FAILURE_RELATIONS = Object.freeze({
  SELF_CAUSED: 'SELF_CAUSED',
  UNRELATED: 'UNRELATED',
  UNCERTAIN: 'UNCERTAIN',
});

export const IMPLEMENTATION_ACTIONS = Object.freeze({
  REPAIR: 'REPAIR',
  RETURN_TO_CONTROL: 'RETURN_TO_CONTROL',
});

export function nextImplementationAction({ failureRelation } = {}) {
  return failureRelation === FAILURE_RELATIONS.SELF_CAUSED
    ? IMPLEMENTATION_ACTIONS.REPAIR
    : IMPLEMENTATION_ACTIONS.RETURN_TO_CONTROL;
}

export function createFailureReturn({ command, evidenceRef, boundary, candidate } = {}) {
  return Object.freeze({
    action: IMPLEMENTATION_ACTIONS.RETURN_TO_CONTROL,
    command,
    evidenceRef,
    boundary,
    candidate: candidate && typeof candidate === 'object'
      ? {
          candidateId: candidate.candidateId,
          generation: candidate.generation,
          headSha: candidate.headSha,
        }
      : candidate,
  });
}
