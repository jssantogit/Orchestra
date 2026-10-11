import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  authorizeCodexLeaseCapability,
  codexCapabilityForTool,
  enterCodexWorkLease,
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

test("authority mode defaults to dual and invalid values fail safe to session", () => {
  assert.equal(resolveCodexAuthorityMode(undefined), "dual");
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

test("tool classifier grants CONTROL only to strict read-only operations", () => {
  assert.equal(codexCapabilityForTool({ tool_name: "apply_patch", tool_input: {} }), "WORKSPACE_EDIT");
  assert.equal(codexCapabilityForTool({ tool_name: "Bash", tool_input: { command: "git status --short" } }), "CONTROL");
  assert.equal(codexCapabilityForTool({ tool_name: "Bash", tool_input: { command: "rg -n foo src" } }), "CONTROL");
  assert.equal(codexCapabilityForTool({ tool_name: "Bash", tool_input: { command: "npm test" } }), "WORKSPACE_EDIT");
  assert.equal(codexCapabilityForTool({ tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ file" } }), "WORKSPACE_EDIT");
});
