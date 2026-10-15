import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDelegationRecord, writeDelegationRecord } from "../../runtime/delegation/store.mjs";

test("completed v2 delegation may retain a sealed artifact workspace without claiming cleanup failure", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "orchestra-delegation-store-v2-"));
  try {
    const record = writeDelegationRecord(repoRoot, {
      delegationId: "delegation-v2-artifact",
      taskId: "task-v2-artifact",
      generation: 9,
      source: { provider: "provider-a", actorIdHash: "sha256:source" },
      target: { provider: "provider-b", logicalRole: "IMPLEMENTER" },
      purpose: "IMPLEMENTATION",
      status: "COMPLETED",
      startedAt: "2026-10-15T03:00:00.000Z",
      completedAt: "2026-10-15T03:00:01.000Z",
      durationMs: 1000,
      failureReason: null,
      artifactId: "delegation-v2-artifact",
      workspace: {
        sourceRevision: "abcdef1234567890",
        initialFingerprint: "sha256:initial",
        finalFingerprint: "sha256:final",
        dirty: true,
        dirtyFileCount: 1,
        cleaned: false,
        retained: true,
        cleanupReason: null,
        recoverablePath: "/tmp/orchestra-retained-review-workspace",
      },
      evidenceRefs: ["test:focused"],
    });

    assert.equal(record.artifactId, "delegation-v2-artifact");
    assert.equal(record.workspace.retained, true);
    assert.equal(record.workspace.cleaned, false);
    assert.equal(record.failureReason, null);
    assert.equal(readDelegationRecord(repoRoot, record.delegationId).valid, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("v1-style completed records cannot retain a workspace without an artifact", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "orchestra-delegation-store-v2-invalid-"));
  try {
    assert.throws(() => writeDelegationRecord(repoRoot, {
      delegationId: "delegation-invalid-retained",
      taskId: "task-invalid-retained",
      generation: 1,
      source: { provider: "provider-a", actorIdHash: "sha256:source" },
      target: { provider: "provider-b", logicalRole: "CRITICAL_REVIEWER" },
      purpose: "INDEPENDENT_REVIEW",
      status: "COMPLETED",
      startedAt: "2026-10-15T03:00:00.000Z",
      completedAt: "2026-10-15T03:00:01.000Z",
      durationMs: 1000,
      failureReason: null,
      workspace: {
        sourceRevision: "abcdef1234567890",
        initialFingerprint: "sha256:initial",
        finalFingerprint: "sha256:final",
        dirty: false,
        dirtyFileCount: 0,
        cleaned: false,
        retained: true,
        cleanupReason: null,
        recoverablePath: "/tmp/forbidden-retained",
      },
      evidenceRefs: [],
    }), /DELEGATION_RECORD_INVALID/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
