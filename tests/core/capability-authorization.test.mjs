import test from "node:test";
import assert from "node:assert/strict";

import { authorizeCapability } from "../../core/policy/capability-authorization.mjs";

const lease = Object.freeze({
  schema: "orchestra.work-lease.v1",
  workspaceId: "primary",
  generation: 3,
  actor: Object.freeze({ provider: "codex", sessionIdHash: "sha256:actor-a" }),
  capabilities: Object.freeze(["WORKSPACE_EDIT", "NETWORK_WRITE"]),
});

const actor = Object.freeze({ provider: "codex", actorIdHash: "sha256:actor-a" });

function packet(overrides = {}) {
  return {
    permissions: {
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
      sideEffects: ["NETWORK_WRITE"],
      ...(overrides.permissions || {}),
    },
    ...overrides,
  };
}

test("missing capability is denied even when a writer lease exists", () => {
  const decision = authorizeCapability({
    actor,
    lease,
    packet: packet(),
    operation: "WRITE",
    capability: "PUBLICATION",
  });
  assert.deepEqual(decision, { allowed: false, reason: "CAPABILITY_NOT_GRANTED" });
});

test("read-only operation requires matching actor and packet discovery authority", () => {
  assert.equal(authorizeCapability({
    actor,
    lease,
    packet: packet(),
    operation: "READ",
    capability: "LOCAL_READ",
  }).allowed, true);

  assert.deepEqual(authorizeCapability({
    actor,
    lease,
    packet: packet({ permissions: { discovery: "NONE", tests: "READ_ONLY", sideEffects: [] } }),
    operation: "READ",
    capability: "LOCAL_READ",
  }), { allowed: false, reason: "PACKET_READ_NOT_GRANTED" });

  assert.deepEqual(authorizeCapability({
    actor: { provider: "codex", actorIdHash: "sha256:other" },
    lease,
    packet: packet(),
    operation: "READ",
    capability: "LOCAL_READ",
  }), { allowed: false, reason: "LEASE_IDENTITY_INVALID" });
});

test("remote side effects require both lease capability and packet authority", () => {
  assert.equal(authorizeCapability({
    actor,
    lease,
    packet: packet(),
    operation: "COMMAND",
    capability: "NETWORK_WRITE",
  }).allowed, true);

  assert.deepEqual(authorizeCapability({
    actor,
    lease,
    packet: packet({ permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: [] } }),
    operation: "COMMAND",
    capability: "NETWORK_WRITE",
  }), { allowed: false, reason: "PACKET_CAPABILITY_NOT_GRANTED" });
});

test("unknown normalized operations fail closed", () => {
  assert.deepEqual(authorizeCapability({
    actor,
    lease,
    packet: packet(),
    operation: "UNKNOWN",
    capability: "WORKSPACE_EDIT",
  }), { allowed: false, reason: "UNKNOWN_OPERATION" });
});
