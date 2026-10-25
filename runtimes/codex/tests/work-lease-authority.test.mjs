import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  authorizeCodexLeaseCapability,
  codexCapabilityForTool,
  enterCodexWorkLease,
  releaseCodexLeaseWrite,
  resolveCodexAuthorityMode,
} from "../.codex/astra-orchestra/work-lease-authority.mjs";

function project() {
  const root = mkdtempSync(join(tmpdir(), "orch-codex-work-lease-"));
  mkdirSync(join(root, ".codex", "orchestra-state"), { recursive: true });
  return root;
}

function state(root, value = {}) {
  writeFileSync(join(root, ".codex", "orchestra-state", "active-state.json"), JSON.stringify(value, null, 2) + "\n");
}

test("authority mode defaults to lease and invalid values fail safe to session", () => {
  assert.equal(resolveCodexAuthorityMode(undefined), "lease");
  assert.equal(resolveCodexAuthorityMode("dual"), "dual");
  assert.equal(resolveCodexAuthorityMode("lease"), "lease");
  assert.equal(resolveCodexAuthorityMode("session"), "session");
  assert.equal(resolveCodexAuthorityMode("surprise"), "session");
});

test("dual mode lets a fresh root advance compatible control without prepared handoff", () => {
  const root = project();
  try {
    state(root, { taskId: "task-1", state: "VERIFYING", candidateId: "candidate-7" });
    const first = enterCodexWorkLease(root, { sessionId: "root-a", mode: "dual" });
    assert.equal(first.authoritative, true);
    assert.equal(first.lease.generation, 0);

    const second = enterCodexWorkLease(root, { sessionId: "root-b", mode: "dual" });
    assert.equal(second.authoritative, true);
    assert.equal(second.reason, null);
    assert.equal(second.lease.generation, 1);
    assert.equal(second.lease.taskId, "task-1");
    assert.deepEqual(second.lease.capabilities, ["CONTROL"]);

    const persisted = readFileSync(join(root, ".orchestra", "state", "work-lease.json"), "utf8");
    assert.doesNotMatch(persisted, /root-a|root-b/);
    assert.match(persisted, /sessionIdHash/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("active workspace writer blocks a fresh root", () => {
  const root = project();
  try {
    state(root, { taskId: "task-1", state: "IMPLEMENTING", candidateId: "candidate-7" });
    const first = enterCodexWorkLease(root, { sessionId: "root-a", mode: "dual" });
    const edit = authorizeCodexLeaseCapability(root, {
      sessionId: "root-a",
      generation: first.lease.generation,
      capability: "WORKSPACE_EDIT",
    });
    assert.equal(edit.allowed, true);
    assert.ok(edit.lease.capabilities.includes("WORKSPACE_EDIT"));

    const second = enterCodexWorkLease(root, { sessionId: "root-b", mode: "dual" });
    assert.equal(second.authoritative, false);
    assert.equal(second.reason, "WRITE_LEASE_ACTIVE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writer lease returns to CONTROL after mutation completes, allowing fresh continuation", () => {
  const root = project();
  try {
    state(root, { taskId: "task-1", state: "IMPLEMENTING", candidateId: "candidate-7" });
    const first = enterCodexWorkLease(root, { sessionId: "root-a", mode: "dual" });
    const edit = authorizeCodexLeaseCapability(root, {
      sessionId: "root-a",
      capability: "WORKSPACE_EDIT",
      mode: "dual",
    });
    assert.equal(edit.allowed, true);
    assert.deepEqual(edit.lease.capabilities, ["CONTROL", "WORKSPACE_EDIT"]);

    const released = releaseCodexLeaseWrite(root, { sessionId: "root-a", mode: "dual" });
    assert.equal(released.released, true);
    assert.equal(released.lease.state, "CONTROL");
    assert.deepEqual(released.lease.capabilities, ["CONTROL"]);

    const second = enterCodexWorkLease(root, { sessionId: "root-b", mode: "dual" });
    assert.equal(second.authoritative, true);
    assert.equal(second.lease.generation, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("former generation is fenced after a fresh root advances control", () => {
  const root = project();
  try {
    state(root, { taskId: "task-1", state: "VERIFYING", candidateId: "candidate-7" });
    const first = enterCodexWorkLease(root, { sessionId: "root-a", mode: "dual" });
    const second = enterCodexWorkLease(root, { sessionId: "root-b", mode: "dual" });
    assert.equal(second.lease.generation, first.lease.generation + 1);

    const stale = authorizeCodexLeaseCapability(root, {
      sessionId: "root-a",
      generation: first.lease.generation,
      capability: "CONTROL",
    });
    assert.equal(stale.allowed, false);
    assert.equal(stale.reason, "STALE_WORK_LEASE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a previously bound stale session cannot auto-claim a newer generation on SessionStart", () => {
  const root = project();
  try {
    state(root, { taskId: "task-1", state: "VERIFYING", candidateId: "candidate-7" });
    const first = enterCodexWorkLease(root, { sessionId: "root-a", mode: "dual" });
    const second = enterCodexWorkLease(root, { sessionId: "root-b", mode: "dual" });
    assert.equal(second.authoritative, true);
    assert.equal(second.lease.generation, 1);

    const staleReentry = enterCodexWorkLease(root, { sessionId: "root-a", mode: "dual" });
    assert.equal(staleReentry.authoritative, false);
    assert.equal(staleReentry.reason, "STALE_WORK_LEASE");
    assert.equal(staleReentry.lease.generation, 1);

    const currentReentry = enterCodexWorkLease(root, { sessionId: "root-b", mode: "dual" });
    assert.equal(currentReentry.authoritative, true);
    assert.equal(currentReentry.lease.generation, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tool classifier grants CONTROL only to strict read-only operations", () => {
  assert.equal(codexCapabilityForTool({ tool_name: "apply_patch", tool_input: {} }), "WORKSPACE_EDIT");
  assert.equal(codexCapabilityForTool({ tool_name: "Bash", tool_input: { command: "git status --short" } }), "CONTROL");
  assert.equal(codexCapabilityForTool({ tool_name: "Bash", tool_input: { command: "rg -n foo src" } }), "CONTROL");
  assert.equal(codexCapabilityForTool({ tool_name: "Bash", tool_input: { command: "npm test" } }), "WORKSPACE_EDIT");
  assert.equal(codexCapabilityForTool({ tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ file" } }), "WORKSPACE_EDIT");
});

test("runtime image change fences old Codex session while allowing a new factual session", () => {
  const root = project();
  try {
    const runtimePath = join(root, ".orchestra", "state", "runtimes", "codex.json");
    mkdirSync(join(root, ".orchestra", "state", "runtimes"), { recursive: true });
    const image = (hash) => JSON.stringify({
      schema: "orchestra.project-runtime.v2", runtime: "codex", runtimeHash: hash, manifestHash: "b".repeat(64),
    });
    writeFileSync(runtimePath, image("a".repeat(64)));
    const original = enterCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(original.authoritative, true);
    assert.equal(authorizeCodexLeaseCapability(root, { sessionId: "root-a", capability: "CONTROL" }).allowed, true);

    writeFileSync(runtimePath, image("c".repeat(64)));
    const stale = authorizeCodexLeaseCapability(root, { sessionId: "root-a", capability: "CONTROL" });
    assert.equal(stale.allowed, false);
    assert.equal(stale.reason, "SESSION_RUNTIME_STALE");
    const reentry = enterCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(reentry.authoritative, false);
    assert.equal(reentry.reason, "SESSION_RUNTIME_STALE");

    const fresh = enterCodexWorkLease(root, { sessionId: "root-b", mode: "lease" });
    assert.equal(fresh.authoritative, true);
    assert.equal(fresh.lease.generation, original.lease.generation + 1);
    assert.equal(authorizeCodexLeaseCapability(root, { sessionId: "root-b", capability: "CONTROL" }).allowed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("native collaboration lifecycle uses CONTROL, not a workspace writer grant", () => {
  assert.equal(codexCapabilityForTool({ tool_name: "collaborationspawn_agent", tool_input: { agent_type: "luna-max" } }), "CONTROL");
  assert.equal(codexCapabilityForTool({ tool_name: "collaborationwait_agent", tool_input: { target: "worker-a" } }), "CONTROL");
  assert.equal(codexCapabilityForTool({ tool_name: "collaborationsend_message", tool_input: { target: "worker-a" } }), "CONTROL");
  assert.equal(codexCapabilityForTool({ tool_name: "collaborationfollowup_task", tool_input: { target: "worker-a" } }), "CONTROL");
  assert.equal(codexCapabilityForTool({ tool_name: "other_spawn_tool" }), "WORKSPACE_EDIT");
});


test("field #155 web research, clarification and agent message require CONTROL, not writer", () => {
  for (const tool_name of ["webrun", "request_user_input_async", "send_message"]) {
    assert.equal(codexCapabilityForTool({ tool_name, tool_input: {} }), "CONTROL", tool_name);
  }
  assert.equal(codexCapabilityForTool({ tool_name: "webrun_delete", tool_input: {} }), "WORKSPACE_EDIT");
});
