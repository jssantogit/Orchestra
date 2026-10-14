import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../runtime/doctor.mjs";
import { writeDelegationRecord } from "../../runtime/delegation/store.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-doctor-recovery-"));
  mkdirSync(join(root, "runtime", "manifests"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.1" }));
  writeFileSync(join(root, "src", "entry.mjs"), "export const ok = true;\n");
  writeFileSync(join(root, "runtime", "manifests", "fixture.json"), JSON.stringify({
    schema: "orchestra.runtime-manifest.v1",
    runtime: "fixture",
    version: "1.0.1",
    sourceRoots: ["src"],
    managedAssets: [{ source: "src/entry.mjs", output: "dist/entry.mjs", type: "file" }],
    preservedProjectPaths: [".orchestra/state"],
    generatedInputs: ["src/entry.mjs"],
    entrypoints: ["dist/entry.mjs"],
  }));
  return root;
}

function cleanupFailedRecord(recoverablePath) {
  return {
    delegationId: "doctor-cleanup-failed",
    taskId: "doctor-cleanup-task",
    generation: 2,
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    status: "CLEANUP_FAILED",
    startedAt: "2026-10-14T18:00:00.000Z",
    completedAt: "2026-10-14T18:00:01.000Z",
    durationMs: 1000,
    failureReason: "WORKSPACE_CLEANUP_FAILED",
    workspace: {
      sourceRevision: "abcdef1234567890",
      initialFingerprint: "sha256:initial",
      finalFingerprint: "sha256:final",
      dirty: false,
      dirtyFileCount: 0,
      cleaned: false,
      cleanupReason: "WORKSPACE_CLEANUP_FAILED",
      recoverablePath,
    },
    evidenceRefs: [],
  };
}

test("Doctor surfaces delegated cleanup failures with bounded recovery paths", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recoverablePath = join(tmpdir(), "orchestra-delegation-orphan");
  writeDelegationRecord(root, cleanupFailedRecord(recoverablePath));

  const report = await runDoctor({
    repoRoot: root,
    runtime: "fixture",
    runCommands: false,
    delegationInspector: async () => ({ status: "READY", gitWorktree: { available: true }, providers: [] }),
  });

  assert.equal(report.delegation.recovery.required, true);
  assert.deepEqual(report.delegation.recovery.cleanupFailures, [{
    delegationId: "doctor-cleanup-failed",
    recoverablePath,
  }]);
});
