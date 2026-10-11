function sameActor(left, right) {
  return Boolean(
    left && right &&
    left.provider === right.provider &&
    left.sessionIdHash === right.sessionIdHash,
  );
}

export function authorizeLeaseMutation({ lease, actor, generation, capability }) {
  if (!lease || !actor || !Number.isInteger(generation) || !capability) {
    return { allowed: false, reason: "LEASE_IDENTITY_INVALID" };
  }
  if (generation !== lease.generation) {
    return { allowed: false, reason: "STALE_WORK_LEASE" };
  }
  if (!sameActor(lease.actor, actor)) {
    return { allowed: false, reason: "LEASE_IDENTITY_INVALID" };
  }
  if (!Array.isArray(lease.capabilities) || !lease.capabilities.includes(capability)) {
    return { allowed: false, reason: "CAPABILITY_NOT_GRANTED" };
  }
  return { allowed: true, reason: null };
}
