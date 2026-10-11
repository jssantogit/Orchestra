import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  authorizeAntigravityLeaseCapability,
  enterAntigravityWorkLease,
  resolveAntigravityAuthorityMode,
} from "../../runtimes/antigravity/.agents/skills/orchestra/work-lease-authority.mjs";

function project() {
  const root = mkdtempSync(join(tmpdir(), "orch-agy-work-lease-"));
  mkdirSync(join(root, ".agents", "state"), { recursive: true });
  return root;
}

function state(root, value = {}) {
  writeFileSync(join(root, ".agents", "state", "active-state.json"), JSON.stringify(value, null, 2) + "\n");
}

test("authority mode defaults to dual and invalid values fail safe to session", () => {
  assert.equal(resolveAntigravityAuthorityMode(undefined), "dual");
  assert.equal(resolveAntigravityAuthorityMode("dual"), "dual");
  assert.equal(resolveAntigravityAuthorityMode("lease"), "lease");
  assert.equal(resolveAntigravityAuthorityMode("session"), "session");
  assert.equal(resolveAntigravityAuthorityMode("surprise"), "session");
});

test("fresh root advances control without explicit orchestrator handoff", () => {
  const root = project();
  try {
    state(root, { taskId: "task-1", state: "VERIFYING", candidateId: "candidate-7" });
    const first = enterAntigravityWorkLease(root, { conversationId: "root-a", profile: "flash-orchestrator", mode: "dual" });
    assert.equal(first.authoritative, true);
    assert.equal(first.lease.generation, 0);

    const second = enterAntigravityWorkLease(root, { conversationId: "root-b", profile: "flash-orchestrator", mode: "dual" });
    assert.equal(second.authoritative, true);
    assert.equal(second.lease.generation, 1);
    assert.equal(second.lease.candidate, "candidate-7");

    const persisted = readFileSync(join(root, ".orchestra", "state", "work-lease.json"), "utf8");
    assert.doesNotMatch(persisted, /root-a|root-b/);
    assert.match(persisted, /sessionIdHash/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("child worker and reviewer identities cannot claim root control from a conversation id", () => {
  const root = project();
  try {
    state(root, { taskId: "task-1", state: "EXECUTING" });
    const worker = enterAntigravityWorkLease(root, {
      conversationId: "child-worker",
      parentConversationId: "root-a",
      role: "WORKER",
      profile: "flash-worker",
      mode: "dual",
    });
    assert.equal(worker.authoritative, false);
    assert.equal(worker.reason, "LEASE_ROOT_REQUIRED");

    const reviewer = enterAntigravityWorkLease(root, {
      conversationId: "reviewer",
      parentConversationId: "root-a",
      role: "REVIEWER",
      profile: "flash-reviewer",
      mode: "dual",
    });
    assert.equal(reviewer.authoritative, false);
    assert.equal(reviewer.reason, "LEASE_ROOT_REQUIRED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("active writer lease blocks a fresh root", () => {
  const root = project();
  try {
    state(root, { taskId: "task-1", state: "IMPLEMENTING" });
    const first = enterAntigravityWorkLease(root, { conversationId: "root-a", profile: "flash-orchestrator", mode: "dual" });
    const edit = authorizeAntigravityLeaseCapability(root, {
      conversationId: "root-a",
      generation: first.lease.generation,
      capability: "WORKSPACE_EDIT",
      mode: "dual",
    });
    assert.equal(edit.allowed, true);

    const second = enterAntigravityWorkLease(root, { conversationId: "root-b", profile: "flash-orchestrator", mode: "dual" });
    assert.equal(second.authoritative, false);
    assert.equal(second.reason, "WRITE_LEASE_ACTIVE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale former root cannot auto-reclaim after generation advances", () => {
  const root = project();
  try {
    state(root, { taskId: "task-1", state: "VERIFYING" });
    enterAntigravityWorkLease(root, { conversationId: "root-a", profile: "flash-orchestrator", mode: "dual" });
    const second = enterAntigravityWorkLease(root, { conversationId: "root-b", profile: "flash-orchestrator", mode: "dual" });
    assert.equal(second.lease.generation, 1);

    const stale = enterAntigravityWorkLease(root, { conversationId: "root-a", profile: "flash-orchestrator", mode: "dual" });
    assert.equal(stale.authoritative, false);
    assert.equal(stale.reason, "STALE_WORK_LEASE");
    assert.equal(stale.lease.generation, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
