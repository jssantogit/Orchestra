import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { enterCodexWorkLease } from "../.codex/astra-orchestra/work-lease-authority.mjs";
import { inspectCodexWorkLease } from "../.codex/astra-orchestra/work-lease-inspector.mjs";

function project() {
  const root = mkdtempSync(join(tmpdir(), "orch-codex-work-lease-diagnostic-"));
  mkdirSync(join(root, ".codex", "orchestra-state"), { recursive: true });
  return root;
}

function activeState(root, value = { taskId: "task-1", state: "VERIFYING" }) {
  writeFileSync(
    join(root, ".codex", "orchestra-state", "active-state.json"),
    JSON.stringify(value, null, 2) + "\n",
  );
}

test("work lease diagnostic reports missing lease as a completed semantic inspection", () => {
  const root = project();
  try {
    const result = inspectCodexWorkLease(root);
    assert.equal(result.schema, "orchestra.codex-work-lease-diagnostic.v1");
    assert.equal(result.completed, true);
    assert.equal(result.status, "MISSING");
    assert.equal(result.reason, "WORK_LEASE_NOT_INITIALIZED");
    assert.equal(result.lease.exists, false);
    assert.equal(result.lease.valid, true);
    assert.equal(result.bindings.valid, true);
    assert.equal(result.authority.resolved, false);
    assert.equal(result.authority.reason, "CODEX_SESSION_ID_NOT_PROVIDED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work lease diagnostic distinguishes invalid persisted lease from a missing lease", () => {
  const root = project();
  try {
    mkdirSync(join(root, ".orchestra", "state"), { recursive: true });
    writeFileSync(join(root, ".orchestra", "state", "work-lease.json"), "{not-json\n");

    const result = inspectCodexWorkLease(root);
    assert.equal(result.completed, true);
    assert.equal(result.status, "INVALID");
    assert.equal(result.reason, "LEASE_PARSE_INVALID");
    assert.equal(result.lease.exists, true);
    assert.equal(result.lease.valid, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work lease diagnostic reports valid structural state without inventing caller identity", () => {
  const root = project();
  try {
    activeState(root);
    const entered = enterCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(entered.authoritative, true);

    const result = inspectCodexWorkLease(root, { mode: "lease" });
    assert.equal(result.completed, true);
    assert.equal(result.status, "READY");
    assert.equal(result.reason, null);
    assert.equal(result.lease.valid, true);
    assert.equal(result.lease.generation, 0);
    assert.equal(result.authority.resolved, false);
    assert.equal(result.authority.allowed, null);
    assert.equal(result.authority.reason, "CODEX_SESSION_ID_NOT_PROVIDED");
    assert.doesNotMatch(JSON.stringify(result), /root-a/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work lease diagnostic resolves factual caller authority without mutating the lease", () => {
  const root = project();
  try {
    activeState(root);
    const entered = enterCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(entered.authoritative, true);

    const result = inspectCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(result.status, "AUTHORIZED");
    assert.equal(result.reason, null);
    assert.equal(result.authority.resolved, true);
    assert.equal(result.authority.allowed, true);
    assert.equal(result.authority.reason, null);
    assert.equal(result.lease.generation, 0);
    assert.doesNotMatch(JSON.stringify(result), /root-a/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work lease diagnostic exposes stale factual caller as semantic denial", () => {
  const root = project();
  try {
    activeState(root);
    const first = enterCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(first.authoritative, true);
    const second = enterCodexWorkLease(root, { sessionId: "root-b", mode: "lease" });
    assert.equal(second.authoritative, true);

    const result = inspectCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(result.completed, true);
    assert.equal(result.status, "DENIED");
    assert.equal(result.reason, "STALE_WORK_LEASE");
    assert.equal(result.authority.resolved, true);
    assert.equal(result.authority.allowed, false);
    assert.equal(result.authority.reason, "STALE_WORK_LEASE");
    assert.equal(result.lease.generation, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work lease diagnostic distinguishes invalid bindings", () => {
  const root = project();
  try {
    activeState(root);
    const entered = enterCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(entered.authoritative, true);
    writeFileSync(
      join(root, ".codex", "orchestra-state", "work-lease-session-bindings.json"),
      JSON.stringify({ schema: "wrong", bindings: {} }, null, 2) + "\n",
    );

    const result = inspectCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(result.completed, true);
    assert.equal(result.status, "INVALID");
    assert.equal(result.reason, "LEASE_BINDINGS_INVALID");
    assert.equal(result.bindings.valid, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work lease diagnostic converts inspection runtime exceptions into an explicit error envelope", () => {
  const result = inspectCodexWorkLease(null);
  assert.equal(result.completed, false);
  assert.equal(result.status, "ERROR");
  assert.equal(result.reason, "WORK_LEASE_DIAGNOSTIC_RUNTIME_ERROR");
  assert.equal(typeof result.error?.message, "string");
});
