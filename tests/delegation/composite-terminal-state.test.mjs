import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readCompositeArtifact,
  restoreCompositeArtifactReadyState,
  transitionCompositeArtifactState,
  writeCompositeArtifact,
} from "../../runtime/delegation/composite-artifact-store.mjs";
import { commitCompositeTerminalState } from "../../runtime/delegation/composite-terminal-state.mjs";

function readyManifest(overrides = {}) {
  return {
    schema: "orchestra.parallel-composite-artifact.v1",
    artifactId: "composite-atomicity",
    groupId: "group-atomicity",
    taskId: "task-atomicity",
    generation: 3,
    source: { provider: "codex", actorIdHash: "sha256:root" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
    delegatedPath: "/tmp/orchestra-implementation-atomicity/workspace",
    syntheticBaselineSha: "1234567890abcdef",
    memberArtifactIds: ["member-a", "member-b"],
    changedPaths: ["src/a.mjs", "src/b.mjs"],
    patchSha256: "sha256:patch",
    mutationDigest: "sha256:mutation",
    state: "READY_FOR_REVIEW",
    createdAt: "2026-10-15T17:00:00.000Z",
    ...overrides,
  };
}

test("composite store can compensate one terminal transition back to the exact READY manifest", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "orchestra-composite-restore-"));
  try {
    const manifest = readyManifest();
    writeCompositeArtifact(repoRoot, { manifest, patch: Buffer.from("patch\n") });
    const promoted = transitionCompositeArtifactState(repoRoot, manifest.artifactId, {
      expectedState: "READY_FOR_REVIEW",
      nextState: "PROMOTED",
      cleanup: {
        cleaned: false,
        reason: "WORKSPACE_CLEANUP_FAILED",
        recoverablePath: manifest.delegatedPath,
      },
    });
    assert.equal(promoted.transitioned, true);

    const restored = restoreCompositeArtifactReadyState(repoRoot, manifest.artifactId, {
      expectedState: "PROMOTED",
      manifest,
    });
    assert.equal(restored.restored, true);
    assert.deepEqual(readCompositeArtifact(repoRoot, manifest.artifactId).manifest, manifest);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("terminal coordinator compensates artifact state when group transition fails", () => {
  const manifest = readyManifest();
  const calls = [];
  const result = commitCompositeTerminalState({
    repoRoot: "/repo",
    artifactId: manifest.artifactId,
    groupId: manifest.groupId,
    memberArtifactIds: manifest.memberArtifactIds,
    nextState: "PROMOTED",
    readyManifest: manifest,
    cleanup: {
      cleaned: false,
      reason: "WORKSPACE_CLEANUP_FAILED",
      recoverablePath: manifest.delegatedPath,
    },
  }, {
    transitionArtifact() {
      calls.push("artifact:promoted");
      return { transitioned: true, reason: null };
    },
    transitionGroup() {
      calls.push("group:failed");
      return { transitioned: false, reason: "PARALLEL_GROUP_STATE_MISMATCH" };
    },
    restoreArtifact() {
      calls.push("artifact:restored");
      return { restored: true, reason: null };
    },
  });

  assert.deepEqual(calls, ["artifact:promoted", "group:failed", "artifact:restored"]);
  assert.deepEqual(result, {
    committed: false,
    compensated: true,
    reason: "PARALLEL_GROUP_STATE_MISMATCH",
  });
});

test("terminal coordinator commits only after artifact and group reach the same terminal state", () => {
  const manifest = readyManifest();
  const calls = [];
  const result = commitCompositeTerminalState({
    repoRoot: "/repo",
    artifactId: manifest.artifactId,
    groupId: manifest.groupId,
    memberArtifactIds: manifest.memberArtifactIds,
    nextState: "DISCARDED",
    readyManifest: manifest,
    cleanup: {
      cleaned: false,
      reason: "WORKSPACE_CLEANUP_FAILED",
      recoverablePath: manifest.delegatedPath,
    },
  }, {
    transitionArtifact() {
      calls.push("artifact:discarded");
      return { transitioned: true, reason: null };
    },
    transitionGroup() {
      calls.push("group:discarded");
      return { transitioned: true, reason: null };
    },
    restoreArtifact() {
      calls.push("unexpected-restore");
      return { restored: true, reason: null };
    },
  });

  assert.deepEqual(calls, ["artifact:discarded", "group:discarded"]);
  assert.deepEqual(result, { committed: true, compensated: false, reason: null });
});
