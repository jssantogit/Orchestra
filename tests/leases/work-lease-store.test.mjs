import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { claimWorkLease, readWorkLease, releaseWorkLease } from "../../core/leases/work-lease-store.mjs";

function root() {
  return mkdtempSync(join(tmpdir(), "orchestra-work-lease-"));
}

const actorA = { provider: "codex", sessionIdHash: "sha256:a" };
const actorB = { provider: "codex", sessionIdHash: "sha256:b" };

test("first claim starts generation zero and compatible later claim advances generation", () => {
  const repoRoot = root();
  const first = claimWorkLease(repoRoot, {
    workspaceId: "primary", taskId: "task-1", actor: actorA, capabilities: ["CONTROL"],
  });
  assert.equal(first.claimed, true);
  assert.equal(first.lease.generation, 0);

  releaseWorkLease(repoRoot, { generation: 0, actor: actorA, terminalState: "DONE" });
  const second = claimWorkLease(repoRoot, {
    workspaceId: "primary", taskId: "task-2", actor: actorB, capabilities: ["CONTROL"], expectedGeneration: 0,
  });
  assert.equal(second.claimed, true);
  assert.equal(second.lease.generation, 1);
});

test("active incompatible writer cannot be stolen", () => {
  const repoRoot = root();
  const first = claimWorkLease(repoRoot, {
    workspaceId: "primary", taskId: "task-1", actor: actorA, capabilities: ["WORKSPACE_EDIT"],
  });
  assert.equal(first.claimed, true);
  const second = claimWorkLease(repoRoot, {
    workspaceId: "primary", taskId: "task-1", actor: actorB, capabilities: ["WORKSPACE_EDIT"], expectedGeneration: 0,
  });
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "WRITE_LEASE_ACTIVE");
});

test("persisted lease round-trips through canonical state", () => {
  const repoRoot = root();
  claimWorkLease(repoRoot, {
    workspaceId: "primary", taskId: "task-1", actor: actorA, capabilities: ["CONTROL"], candidate: null,
  });
  const read = readWorkLease(repoRoot);
  assert.equal(read.exists, true);
  assert.equal(read.valid, true);
  assert.equal(read.lease.schema, "orchestra.work-lease.v1");
  assert.equal(read.lease.actor.sessionIdHash, actorA.sessionIdHash);
});
