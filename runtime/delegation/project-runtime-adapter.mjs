import { hasInFlightDelegation } from "./store.mjs";

export async function checkDelegationProjectRuntimeQuiescence(targetDir) {
  try {
    if (hasInFlightDelegation(targetDir)) {
      return { safe: false, reason: "DELEGATION_IN_FLIGHT" };
    }
    return { safe: true, reason: "NO_DELEGATION_IN_FLIGHT" };
  } catch {
    return { safe: false, reason: "DELEGATION_STATE_UNREADABLE" };
  }
}

export const delegationProjectRuntimeAdapter = Object.freeze({
  checkQuiescence: checkDelegationProjectRuntimeQuiescence,
});
