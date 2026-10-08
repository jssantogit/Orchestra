export const IMPLEMENTATION_ACTIONS = Object.freeze({
  REPAIR: "REPAIR",
  RETURN_TO_CONTROL: "RETURN_TO_CONTROL",
});

export function nextImplementationAction({ failureRelation } = {}) {
  return failureRelation === "SELF_CAUSED"
    ? IMPLEMENTATION_ACTIONS.REPAIR
    : IMPLEMENTATION_ACTIONS.RETURN_TO_CONTROL;
}

export function createFailureReturn({ command, evidenceRef, boundary, candidate } = {}) {
  return {
    type: "IMPLEMENTATION_FAILURE_RETURN",
    action: IMPLEMENTATION_ACTIONS.RETURN_TO_CONTROL,
    command,
    evidenceRef,
    boundary,
    candidate,
  };
}
