import { createRuntimeEvent } from "../../core/events/runtime-event.mjs";
import { assertDelegationId } from "./store.mjs";

const STATES = new Set(["STARTED", "COMPLETED", "FAILED", "TIMED_OUT", "CLEANUP_FAILED"]);
const INPUT_KEYS = new Set(["delegationId", "state", "generation", "taskId", "actor"]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function createDelegationLifecycleEvent(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("DELEGATION_EVENT_INPUT_INVALID");
  if (!Object.keys(input).every((key) => INPUT_KEYS.has(key))) fail("DELEGATION_EVENT_INPUT_INVALID");

  const { delegationId, state, generation, taskId = null, actor = null } = input;
  assertDelegationId(delegationId);
  if (!STATES.has(state)) fail("DELEGATION_EVENT_STATE_INVALID");

  return createRuntimeEvent({
    eventId: `delegation:${delegationId}:${state.toLowerCase()}`,
    type: `DELEGATION_${state}`,
    generation,
    taskId,
    actor,
    payload: {},
  });
}
