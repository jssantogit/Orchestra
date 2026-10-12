import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { acquireAtomicLock, releaseAtomicLock } from "../../core/leases/atomic-lock.mjs";

function lockPath() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-lock-"));
  return join(root, ".orchestra", "state", "claim.lock");
}

test("live atomic lock cannot be stolen", () => {
  const path = lockPath();
  const first = acquireAtomicLock(path, { ownerIdHash: "owner-a", staleAfterMs: 60_000 });
  assert.equal(first.acquired, true);
  const second = acquireAtomicLock(path, { ownerIdHash: "owner-b", staleAfterMs: 60_000 });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "LOCK_ACTIVE");
  releaseAtomicLock(first.handle);
});

test("dead owner lock can be recovered", () => {
  const path = lockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: 99999999, ownerIdHash: "dead", createdAt: new Date(0).toISOString() }) + "\n");
  const claimed = acquireAtomicLock(path, { ownerIdHash: "new-owner", staleAfterMs: 1 });
  assert.equal(claimed.acquired, true);
  const record = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(record.ownerIdHash, "new-owner");
  releaseAtomicLock(claimed.handle);
});

test("fresh malformed lock fails closed", () => {
  const path = lockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "not-json\n");
  const now = new Date();
  utimesSync(path, now, now);
  const result = acquireAtomicLock(path, { ownerIdHash: "owner", staleAfterMs: 60_000 });
  assert.equal(result.acquired, false);
  assert.equal(result.reason, "LOCK_MALFORMED_FRESH");
});
