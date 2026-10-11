import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  authorizeAntigravityLeaseCapability,
  enterAntigravityWorkLease,
  resolveAntigravityAuthorityMode,
} from "../../runtimes/antigravity/.agents/skills/orchestra/work-lease-authority.mjs";

const orchestraRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const preInvocationWrapper = join(orchestraRoot, "runtimes/antigravity/.agents/hooks/work-lease-pre-invocation.mjs");
const preToolWrapper = join(orchestraRoot, "runtimes/antigravity/.agents/hooks/work-lease-pre-tool.mjs");

function project() {
  const root = mkdtempSync(join(tmpdir(), "orch-agy-work-lease-"));
  mkdirSync(join(root, ".agents", "state"), { recursive: true });
  mkdirSync(join(root, ".agents", "telemetry"), { recursive: true });
  return root;
}

function state(root, value = {}) {
  writeFileSync(join(root, ".agents", "state", "active-state.json"), JSON.stringify(value, null, 2) + "\n");
}

function runHook(script, root, payload, mode = "dual") {
  return JSON.parse(execFileSync(process.execPath, [script], {
    cwd: root,
    input: JSON.stringify({ workspacePaths: [root], ...payload }),
    encoding: "utf8",
    env: { ...process.env, ORCHESTRA_AUTHORITY_MODE: mode },
  }));
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

test("hook layer projects current lease root for legacy compatibility and fences former root tools", () => {
  const root = project();
  try {
    state(root, {
      taskId: "task-1",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      state: "VERIFYING",
      candidateId: "candidate-7",
      activeRole: "ORCHESTRATOR",
      agentProfile: "flash-orchestrator",
    });

    const first = runHook(preInvocationWrapper, root, {
      conversationId: "root-a",
      modelName: "gemini-3.8-flash-medium",
    });
    assert.match(JSON.stringify(first), /WORK LEASE AUTHORITY/);

    const second = runHook(preInvocationWrapper, root, {
      conversationId: "root-b",
      modelName: "gemini-3.8-flash-medium",
    });
    assert.match(JSON.stringify(second), /generation=1/);
    assert.doesNotMatch(JSON.stringify(second), /ORCHESTRATOR HANDOFF REQUIRED/);

    const bindings = JSON.parse(readFileSync(join(root, ".agents", "state", "role-bindings.json"), "utf8"));
    assert.equal(bindings.mainConversationId, "root-b");
    assert.equal(bindings.bindings["root-a"].role, "FORMER_ORCHESTRATOR");
    assert.equal(bindings.bindings["root-b"].role, "ORCHESTRATOR");
    assert.equal(bindings.bindings["root-b"].workLeaseGeneration, 1);

    const staleInvocation = runHook(preInvocationWrapper, root, {
      conversationId: "root-a",
      modelName: "gemini-3.8-flash-medium",
    });
    assert.match(JSON.stringify(staleInvocation), /STALE_WORK_LEASE/);
    const afterStale = JSON.parse(readFileSync(join(root, ".agents", "state", "role-bindings.json"), "utf8"));
    assert.equal(afterStale.mainConversationId, "root-b");

    const staleTool = runHook(preToolWrapper, root, {
      conversationId: "root-a",
      toolCall: { name: "view_file", args: { path: "product.txt" } },
    });
    assert.equal(staleTool.decision, "deny");
    assert.match(staleTool.reason, /WORK_LEASE_AUTHORITY_DENIED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
