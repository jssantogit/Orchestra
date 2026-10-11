const READ_OPERATIONS = new Set(["READ", "INSPECT", "SEARCH", "LIST"]);
const LOCAL_MUTATION_CAPABILITIES = new Set(["WORKSPACE_EDIT", "LOCAL_WRITE"]);

function token(value) {
  return typeof value === "string"
    ? value.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : "";
}

export function normalizeAuthorizationActor(actor = {}) {
  if (!actor || typeof actor !== "object") return null;
  const provider = typeof actor.provider === "string" ? actor.provider.trim() : "";
  const sessionIdHash = typeof actor.sessionIdHash === "string" && actor.sessionIdHash.trim()
    ? actor.sessionIdHash.trim()
    : (typeof actor.actorIdHash === "string" ? actor.actorIdHash.trim() : "");
  if (!provider || !sessionIdHash) return null;
  return { provider, sessionIdHash };
}

function sameActor(leaseActor, actor) {
  const normalized = normalizeAuthorizationActor(actor);
  return Boolean(
    normalized
    && leaseActor
    && normalized.provider === leaseActor.provider
    && normalized.sessionIdHash === leaseActor.sessionIdHash,
  );
}

function packetPermissions(packet) {
  if (!packet || typeof packet !== "object" || !packet.permissions || typeof packet.permissions !== "object") {
    return null;
  }
  return packet.permissions;
}

function packetSideEffects(permissions) {
  return new Set(
    (Array.isArray(permissions?.sideEffects) ? permissions.sideEffects : [])
      .map(token)
      .filter(Boolean),
  );
}

/**
 * Provider-neutral capability gate. Provider adapters normalize tool facts;
 * this layer decides whether factual lease + packet authority permits the
 * requested operation. Narrative instructions are intentionally ignored.
 */
export function authorizeCapability({ actor, lease, packet, operation, capability } = {}) {
  const normalizedOperation = token(operation);
  const normalizedCapability = token(capability);

  if (!normalizedOperation || normalizedOperation === "UNKNOWN") {
    return { allowed: false, reason: "UNKNOWN_OPERATION" };
  }
  if (!lease || !sameActor(lease.actor, actor)) {
    return { allowed: false, reason: "LEASE_IDENTITY_INVALID" };
  }

  const permissions = packetPermissions(packet);
  if (!permissions) {
    return { allowed: false, reason: "PACKET_AUTHORITY_INVALID" };
  }

  if (READ_OPERATIONS.has(normalizedOperation)) {
    if (token(permissions.discovery) === "NONE") {
      return { allowed: false, reason: "PACKET_READ_NOT_GRANTED" };
    }
    return { allowed: true, reason: null };
  }

  if (!normalizedCapability || !Array.isArray(lease.capabilities) || !lease.capabilities.map(token).includes(normalizedCapability)) {
    return { allowed: false, reason: "CAPABILITY_NOT_GRANTED" };
  }

  // Local workspace mutation is fenced by the Work Lease itself. External or
  // other side effects additionally require explicit packet authority.
  if (!LOCAL_MUTATION_CAPABILITIES.has(normalizedCapability)) {
    const packetCaps = packetSideEffects(permissions);
    if (!packetCaps.has(normalizedCapability)) {
      return { allowed: false, reason: "PACKET_CAPABILITY_NOT_GRANTED" };
    }
  }

  return { allowed: true, reason: null };
}
