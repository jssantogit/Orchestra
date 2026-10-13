import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hasInFlightDelegation,
  listDelegationRecords,
  readDelegationRecord,
  writeDelegationRecord,
} from "../../runtime/delegation/store.mjs";
import { createDelegationLifecycleEvent } from "../../runtime/delegation/events.mjs";

function root(t) {
  const value = mkdtempSync(join(tmpdir(), "orchestra-delegation-store-"));
  t.after(() => rmSync(value, { recursive: true, force: true }));
  return value;
}

function startedRecord(overrides = {}) {
  return {
    delegationId: "delegation-123",
    taskId: "task-123",
    generation: 4,
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    status: "STARTED",
    startedAt: "2026-10-13T14:00:00.000Z",
    completedAt: null,
    durationMs: null,
    failureReason: null,
    workspace: {
      sourceRevision: "abcdef1234567890",
      initialFingerprint: "sha256:initial",
      finalFingerprint: null,
      dirty: false,
      dirtyFileCount: 0,
      cleaned: false,
      cleanupReason: null,
      recoverablePath: null,
    },
    evidenceRefs: [],
    ...overrides,
  };
}

test("delegation records round-trip under canonical state with bounded identity only", (t) => {
  const repoRoot = root(t);
  const record = startedRecord();
  const written = writeDelegationRecord(repoRoot, record);

  assert.equal(written.schema, "orchestra.delegation-record.v1");
  const read = readDelegationRecord(repoRoot, record.delegationId);
  assert.equal(read.exists, true);
  assert.equal(read.valid, true);
  assert.deepEqual(read.record, written);

  const path = join(repoRoot, ".orchestra", "state", "delegations", "delegation-123.json");
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(path, "utf8").endsWith("\n"), true);
});

test("store rejects unsafe IDs and path traversal before filesystem access", (t) => {
  const repoRoot = root(t);
  for (const delegationId of ["../escape", "..", ".", "a/b", "a\\b", "/absolute", "C:\\absolute"]) {
    assert.throws(
      () => readDelegationRecord(repoRoot, delegationId),
      /DELEGATION_ID_INVALID/,
      delegationId,
    );
    assert.throws(
      () => writeDelegationRecord(repoRoot, startedRecord({ delegationId })),
      /DELEGATION_ID_INVALID/,
      delegationId,
    );
  }
  assert.equal(existsSync(join(repoRoot, ".orchestra")), false);
});

test("store rejects raw narrative and unknown channels instead of silently persisting them", (t) => {
  const repoRoot = root(t);
  for (const extra of [
    { prompt: "secret" },
    { transcript: "secret" },
    { reasoning: "chain" },
    { stdout: "raw" },
    { stderr: "raw" },
    { output: "raw" },
    { arbitrary: "field" },
  ]) {
    assert.throws(
      () => writeDelegationRecord(repoRoot, startedRecord(extra)),
      /DELEGATION_RECORD_INVALID/,
      Object.keys(extra)[0],
    );
  }
});

test("store bounds arrays and strings and rejects malformed terminal facts", (t) => {
  const repoRoot = root(t);
  assert.throws(
    () => writeDelegationRecord(repoRoot, startedRecord({ evidenceRefs: Array.from({ length: 65 }, (_, i) => `ref-${i}`) })),
    /DELEGATION_RECORD_INVALID/,
  );
  assert.throws(
    () => writeDelegationRecord(repoRoot, startedRecord({ taskId: "x".repeat(301) })),
    /DELEGATION_RECORD_INVALID/,
  );
  assert.throws(
    () => writeDelegationRecord(repoRoot, startedRecord({ status: "COMPLETED", completedAt: null, durationMs: null })),
    /DELEGATION_RECORD_INVALID/,
  );
});

test("list is deterministic and in-flight detection clears on terminal records", (t) => {
  const repoRoot = root(t);
  writeDelegationRecord(repoRoot, startedRecord({ delegationId: "b-delegation" }));
  writeDelegationRecord(repoRoot, startedRecord({ delegationId: "a-delegation" }));

  assert.equal(hasInFlightDelegation(repoRoot), true);
  assert.deepEqual(
    listDelegationRecords(repoRoot).map((record) => record.delegationId),
    ["a-delegation", "b-delegation"],
  );

  writeDelegationRecord(repoRoot, startedRecord({
    delegationId: "a-delegation",
    status: "COMPLETED",
    completedAt: "2026-10-13T14:00:01.000Z",
    durationMs: 1000,
    workspace: {
      ...startedRecord().workspace,
      finalFingerprint: "sha256:final-a",
      cleaned: true,
    },
    evidenceRefs: ["test:focused"],
  }));
  assert.equal(hasInFlightDelegation(repoRoot), true);

  writeDelegationRecord(repoRoot, startedRecord({
    delegationId: "b-delegation",
    status: "FAILED",
    completedAt: "2026-10-13T14:00:02.000Z",
    durationMs: 2000,
    failureReason: "EXECUTION_FAILED",
    workspace: {
      ...startedRecord().workspace,
      finalFingerprint: "sha256:final-b",
      cleaned: true,
    },
  }));
  assert.equal(hasInFlightDelegation(repoRoot), false);
});

test("cleanup failure preserves only bounded recoverability facts", (t) => {
  const repoRoot = root(t);
  const record = writeDelegationRecord(repoRoot, startedRecord({
    status: "CLEANUP_FAILED",
    completedAt: "2026-10-13T14:00:03.000Z",
    durationMs: 3000,
    failureReason: "WORKSPACE_CLEANUP_FAILED",
    workspace: {
      ...startedRecord().workspace,
      finalFingerprint: "sha256:final",
      dirty: true,
      dirtyFileCount: 2,
      cleaned: false,
      cleanupReason: "WORKSPACE_CLEANUP_FAILED",
      recoverablePath: "/tmp/orchestra-delegation-recoverable",
    },
  }));

  assert.equal(record.workspace.recoverablePath, "/tmp/orchestra-delegation-recoverable");
  assert.equal(JSON.stringify(record).includes("prompt"), false);
  assert.equal(hasInFlightDelegation(repoRoot), false);
});

test("corrupted record is reported invalid and never counted as healthy in-flight state", (t) => {
  const repoRoot = root(t);
  writeDelegationRecord(repoRoot, startedRecord());
  const path = join(repoRoot, ".orchestra", "state", "delegations", "delegation-123.json");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, "{not-json\n", "utf8");

  const read = readDelegationRecord(repoRoot, "delegation-123");
  assert.equal(read.exists, true);
  assert.equal(read.valid, false);
  assert.equal(read.reason, "DELEGATION_RECORD_PARSE_INVALID");
  assert.throws(() => hasInFlightDelegation(repoRoot), /DELEGATION_RECORD_INVALID/);

  writeFileSync(path, original, "utf8");
});

test("delegation lifecycle events use canonical empty payloads and explicit correlated IDs", () => {
  const actor = { provider: "provider-a", actorIdHash: "sha256:actor" };
  for (const state of ["STARTED", "COMPLETED", "FAILED", "TIMED_OUT", "CLEANUP_FAILED"]) {
    const event = createDelegationLifecycleEvent({
      delegationId: "delegation-123",
      state,
      generation: 4,
      taskId: "task-123",
      actor,
    });
    assert.equal(event.schema, "orchestra.runtime-event.v1");
    assert.equal(event.eventId, `delegation:delegation-123:${state.toLowerCase()}`);
    assert.equal(event.type, `DELEGATION_${state}`);
    assert.equal(event.generation, 4);
    assert.equal(event.taskId, "task-123");
    assert.deepEqual(event.actor, { provider: "provider-a", sessionIdHash: "sha256:actor" });
    assert.deepEqual(event.payload, {});
  }
});

test("delegation lifecycle event rejects unsafe IDs, unsupported states, and narrative payload injection", () => {
  assert.throws(
    () => createDelegationLifecycleEvent({ delegationId: "../bad", state: "STARTED", generation: 1 }),
    /DELEGATION_ID_INVALID/,
  );
  assert.throws(
    () => createDelegationLifecycleEvent({ delegationId: "delegation-1", state: "POLLING", generation: 1 }),
    /DELEGATION_EVENT_STATE_INVALID/,
  );
  assert.throws(
    () => createDelegationLifecycleEvent({
      delegationId: "delegation-1",
      state: "FAILED",
      generation: 1,
      payload: { reasoning: "no" },
    }),
    /DELEGATION_EVENT_INPUT_INVALID/,
  );
});
