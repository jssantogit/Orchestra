import test from "node:test";
import assert from "node:assert/strict";

import { authorizeLeaseMutation } from "../../core/leases/lease-authorizer.mjs";

const actor = { provider: "codex", sessionIdHash: "sha256:a" };
const lease = {
  schema: "orchestra.work-lease.v1",
  projectLineage: "lineage-1",
  workspaceId: "primary",
  taskId: "task-1",
  generation: 2,
  state: "IMPLEMENTING",
  actor,
  capabilities: ["WORKSPACE_EDIT"],
  candidate: null,
};

test("stale generation is always denied", () => {
  const result = authorizeLeaseMutation({ lease, actor, generation: 1, capability: "WORKSPACE_EDIT" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "STALE_WORK_LEASE");
});

test("missing capability is denied", () => {
  const result = authorizeLeaseMutation({ lease, actor, generation: 2, capability: "REMOTE_PUSH" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "CAPABILITY_NOT_GRANTED");
});

test("matching actor generation and capability are allowed", () => {
  const result = authorizeLeaseMutation({ lease, actor, generation: 2, capability: "WORKSPACE_EDIT" });
  assert.deepEqual(result, { allowed: true, reason: null });
});
