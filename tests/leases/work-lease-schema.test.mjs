import test from "node:test";
import assert from "node:assert/strict";

import { validateWorkLease } from "../../core/domain/work-lease.mjs";

test("canonical Work Lease accepts hashed actor provenance without raw session id", () => {
  const lease = {
    schema: "orchestra.work-lease.v1",
    projectLineage: "lineage-1",
    workspaceId: "primary",
    taskId: "task-1",
    generation: 0,
    state: "CONTROL",
    actor: { provider: "codex", sessionIdHash: "sha256:abc" },
    capabilities: ["CONTROL"],
    candidate: null,
  };
  const result = validateWorkLease(lease);
  assert.equal(result.valid, true);
  assert.equal("sessionId" in lease.actor, false);
});

test("canonical Work Lease rejects raw provider session identity fields", () => {
  const lease = {
    schema: "orchestra.work-lease.v1",
    projectLineage: "lineage-1",
    workspaceId: "primary",
    taskId: "task-1",
    generation: 0,
    state: "CONTROL",
    actor: { provider: "codex", sessionIdHash: "sha256:abc", sessionId: "raw-secret-session" },
    capabilities: ["CONTROL"],
    candidate: null,
  };
  assert.equal(validateWorkLease(lease).valid, false);
});
