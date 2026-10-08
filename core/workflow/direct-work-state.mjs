export const DIRECT_WORK_STATES = Object.freeze({
  INTAKE: "INTAKE",
  RESOLVING: "RESOLVING",
  IMPLEMENTATION_READY: "IMPLEMENTATION_READY",
  IMPLEMENTING: "IMPLEMENTING",
  CANDIDATE_READY: "CANDIDATE_READY",
  EVIDENCE_PENDING: "EVIDENCE_PENDING",
  AUDIT_PENDING: "AUDIT_PENDING",
  ACCEPTANCE: "ACCEPTANCE",
  DONE: "DONE",
  BLOCKED: "BLOCKED",
  HUMAN_GATE: "HUMAN_GATE",
});

const TERMINAL_STATES = new Set([
  DIRECT_WORK_STATES.DONE,
  DIRECT_WORK_STATES.BLOCKED,
  DIRECT_WORK_STATES.HUMAN_GATE,
]);

const TRANSITIONS = Object.freeze({
  [DIRECT_WORK_STATES.INTAKE]: Object.freeze({
    RESOLVE: DIRECT_WORK_STATES.RESOLVING,
  }),
  [DIRECT_WORK_STATES.RESOLVING]: Object.freeze({
    IMPLEMENTATION_READY: DIRECT_WORK_STATES.IMPLEMENTATION_READY,
  }),
  [DIRECT_WORK_STATES.IMPLEMENTATION_READY]: Object.freeze({
    START_IMPLEMENTATION: DIRECT_WORK_STATES.IMPLEMENTING,
  }),
  [DIRECT_WORK_STATES.IMPLEMENTING]: Object.freeze({
    CANDIDATE_CREATED: DIRECT_WORK_STATES.CANDIDATE_READY,
  }),
  [DIRECT_WORK_STATES.CANDIDATE_READY]: Object.freeze({
    EVIDENCE_REQUIRED: DIRECT_WORK_STATES.EVIDENCE_PENDING,
    AUDIT_REQUIRED: DIRECT_WORK_STATES.AUDIT_PENDING,
    VERIFICATION_COMPLETE: DIRECT_WORK_STATES.ACCEPTANCE,
  }),
  [DIRECT_WORK_STATES.EVIDENCE_PENDING]: Object.freeze({
    VERIFICATION_COMPLETE: DIRECT_WORK_STATES.ACCEPTANCE,
  }),
  [DIRECT_WORK_STATES.AUDIT_PENDING]: Object.freeze({
    VERIFICATION_COMPLETE: DIRECT_WORK_STATES.ACCEPTANCE,
  }),
  [DIRECT_WORK_STATES.ACCEPTANCE]: Object.freeze({
    ACCEPT: DIRECT_WORK_STATES.DONE,
  }),
});

export function transitionDirectWork(state, event) {
  if (!Object.values(DIRECT_WORK_STATES).includes(state)) {
    return Object.freeze({
      allowed: false,
      nextState: state,
      reason: "UNKNOWN_STATE",
    });
  }

  if (TERMINAL_STATES.has(state)) {
    return Object.freeze({
      allowed: false,
      nextState: state,
      reason: "TERMINAL_STATE",
    });
  }

  if (event === "BLOCK") {
    return Object.freeze({
      allowed: true,
      nextState: DIRECT_WORK_STATES.BLOCKED,
      reason: "ALLOWED_TRANSITION",
    });
  }

  if (event === "HUMAN_GATE") {
    return Object.freeze({
      allowed: true,
      nextState: DIRECT_WORK_STATES.HUMAN_GATE,
      reason: "ALLOWED_TRANSITION",
    });
  }

  const nextState = TRANSITIONS[state]?.[event];
  if (!nextState) {
    return Object.freeze({
      allowed: false,
      nextState: state,
      reason: "TRANSITION_NOT_ALLOWED",
    });
  }

  return Object.freeze({
    allowed: true,
    nextState,
    reason: "ALLOWED_TRANSITION",
  });
}
