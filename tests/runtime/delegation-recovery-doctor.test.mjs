import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../runtime/doctor.mjs";
import { writeDelegationArtifact } from "../../runtime/delegation/artifact-store.mjs";
import { writeCompositeArtifact } from "../../runtime/delegation/composite-artifact-store.mjs";
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

function retainedArtifact(reviewPath, overrides = {}) {
  return {
    schema: "orchestra.delegation-artifact.v1",
    artifactId: "doctor-retained-artifact",
    delegationId: "doctor-retained-artifact",
    taskId: "doctor-retained-task",
    generation: 3,
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
    delegatedPath: reviewPath,
    syntheticBaselineSha: "1234567890abcdef",
    mutationScope: {
      allowedPaths: ["src/**"],
      forbiddenPaths: [".git/**", ".orchestra/state/**"],
    },
    changedPaths: ["src/entry.mjs"],
    patchSha256: "sha256:patch",
    mutationDigest: "sha256:mutation",
    state: "READY_FOR_REVIEW",
    createdAt: "2026-10-15T04:00:00.000Z",
    ...overrides,
  };
}

function retainedCompositeArtifact(reviewPath, overrides = {}) {
  return {
    schema: "orchestra.parallel-composite-artifact.v1",
    artifactId: "doctor-retained-composite",
    groupId: "doctor-parallel-group",
    taskId: "doctor-parallel-task",
    generation: 3,
    source: { provider: "codex", actorIdHash: "sha256:control" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
    delegatedPath: reviewPath,
    syntheticBaselineSha: "1234567890abcdef",
    memberArtifactIds: ["doctor-member-a", "doctor-member-b"],
    changedPaths: ["src/entry.mjs"],
    patchSha256: "sha256:composite-patch",
    mutationDigest: "sha256:composite-mutation",
    state: "READY_FOR_REVIEW",
    createdAt: "2026-10-15T04:00:00.000Z",
    ...overrides,
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

test("Doctor surfaces READY_FOR_REVIEW implementation artifacts without treating review as cleanup failure", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reviewPath = join(tmpdir(), "orchestra-implementation-doctor", "workspace");
  writeDelegationArtifact(root, {
    manifest: retainedArtifact(reviewPath),
    patch: Buffer.from("diff --git a/src/entry.mjs b/src/entry.mjs\n", "utf8"),
  });

  const report = await runDoctor({
    repoRoot: root,
    runtime: "fixture",
    runCommands: false,
    delegationInspector: async () => ({ status: "READY", gitWorktree: { available: true }, providers: [] }),
  });

  assert.equal(report.delegation.recovery.required, false);
  assert.equal(report.delegation.recovery.reason, null);
  assert.deepEqual(report.delegation.recovery.retainedArtifacts, [{
    artifactId: "doctor-retained-artifact",
    state: "READY_FOR_REVIEW",
    reviewPath,
  }]);
});

test("Doctor surfaces READY parallel composite artifacts as retained review state", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reviewPath = join(tmpdir(), "orchestra-parallel-doctor", "workspace");
  writeCompositeArtifact(root, {
    manifest: retainedCompositeArtifact(reviewPath),
    patch: Buffer.from("diff --git a/src/entry.mjs b/src/entry.mjs\n", "utf8"),
  });

  const report = await runDoctor({
    repoRoot: root,
    runtime: "fixture",
    runCommands: false,
    delegationInspector: async () => ({ status: "READY", gitWorktree: { available: true }, providers: [] }),
  });

  assert.equal(report.delegation.recovery.required, false);
  assert.equal(report.delegation.recovery.reason, null);
  assert.deepEqual(report.delegation.recovery.retainedCompositeArtifacts, [{
    artifactId: "doctor-retained-composite",
    groupId: "doctor-parallel-group",
    state: "READY_FOR_REVIEW",
    reviewPath,
  }]);
});

test("Doctor surfaces post-promotion artifact cleanup failures with recoverable clone paths", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recoverablePath = join(tmpdir(), "orchestra-implementation-promoted-orphan", "workspace");
  writeDelegationArtifact(root, {
    manifest: retainedArtifact(recoverablePath, {
      artifactId: "doctor-promoted-cleanup-failed",
      delegationId: "doctor-promoted-cleanup-failed",
      state: "PROMOTED",
      cleanup: {
        cleaned: false,
        reason: "WORKSPACE_CLEANUP_FAILED",
        recoverablePath,
      },
    }),
    patch: Buffer.from("diff --git a/src/entry.mjs b/src/entry.mjs\n", "utf8"),
  });

  const report = await runDoctor({
    repoRoot: root,
    runtime: "fixture",
    runCommands: false,
    delegationInspector: async () => ({ status: "READY", gitWorktree: { available: true }, providers: [] }),
  });

  assert.equal(report.delegation.recovery.required, true);
  assert.equal(report.delegation.recovery.reason, "WORKSPACE_CLEANUP_FAILED");
  assert.deepEqual(report.delegation.recovery.artifactCleanupFailures, [{
    artifactId: "doctor-promoted-cleanup-failed",
    state: "PROMOTED",
    recoverablePath,
  }]);
});

test("Doctor surfaces post-promotion composite cleanup failures with recoverable clone paths", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recoverablePath = join(tmpdir(), "orchestra-parallel-promoted-orphan", "workspace");
  writeCompositeArtifact(root, {
    manifest: retainedCompositeArtifact(recoverablePath, {
      artifactId: "doctor-composite-cleanup-failed",
      state: "PROMOTED",
      cleanup: {
        cleaned: false,
        reason: "WORKSPACE_CLEANUP_FAILED",
        recoverablePath,
      },
    }),
    patch: Buffer.from("diff --git a/src/entry.mjs b/src/entry.mjs\n", "utf8"),
  });

  const report = await runDoctor({
    repoRoot: root,
    runtime: "fixture",
    runCommands: false,
    delegationInspector: async () => ({ status: "READY", gitWorktree: { available: true }, providers: [] }),
  });

  assert.equal(report.delegation.recovery.required, true);
  assert.equal(report.delegation.recovery.reason, "WORKSPACE_CLEANUP_FAILED");
  assert.deepEqual(report.delegation.recovery.compositeCleanupFailures, [{
    artifactId: "doctor-composite-cleanup-failed",
    groupId: "doctor-parallel-group",
    state: "PROMOTED",
    recoverablePath,
  }]);
});
