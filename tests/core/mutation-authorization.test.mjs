import test from "node:test";
import assert from "node:assert/strict";

import { authorizeMutation } from "../../core/policy/mutation-authorization.mjs";

const lease = Object.freeze({
  schema: "orchestra.work-lease.v1",
  workspaceId: "primary",
  generation: 7,
  actor: Object.freeze({ provider: "antigravity", sessionIdHash: "sha256:actor-a" }),
  capabilities: Object.freeze(["WORKSPACE_EDIT"]),
});
const actor = Object.freeze({ provider: "antigravity", actorIdHash: "sha256:actor-a" });
const workspace = Object.freeze({ workspaceId: "primary" });

test("stale generation is fenced before provider-specific execution", () => {
  assert.deepEqual(authorizeMutation({ actor, lease, generation: 6, workspace, operation: "WRITE" }), {
    allowed: false,
    reason: "STALE_WORK_LEASE",
  });
});

test("matching writer lease authorizes workspace mutation for normalized actors", () => {
  assert.deepEqual(authorizeMutation({ actor, lease, generation: 7, workspace, operation: "WRITE" }), {
    allowed: true,
    reason: null,
  });
});

test("workspace identity is part of mutation authority", () => {
  assert.deepEqual(authorizeMutation({
    actor,
    lease,
    generation: 7,
    workspace: { workspaceId: "secondary" },
    operation: "WRITE",
  }), { allowed: false, reason: "WORKSPACE_ID_MISMATCH" });
});

test("UNKNOWN adapter events cannot acquire mutation authority", () => {
  assert.deepEqual(authorizeMutation({ actor, lease, generation: 7, workspace, operation: "UNKNOWN" }), {
    allowed: false,
    reason: "UNKNOWN_OPERATION",
  });
});
