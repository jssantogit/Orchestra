import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readDelegationArtifact,
  recordDelegationArtifactCleanup,
  transitionDelegationArtifactState,
  writeDelegationArtifact,
} from "../../runtime/delegation/artifact-store.mjs";
import { promoteDelegationArtifact } from "../../runtime/delegation/artifact-lifecycle.mjs";

function manifest(id = "parallel-member-artifact", overrides = {}) {
  return {
    schema: "orchestra.delegation-artifact.v1",
    artifactId: id,
    delegationId: id,
    taskId: "parallel-task",
    generation: 7,
    source: { provider: "codex", actorIdHash: "sha256:source-actor" },
    target: { provider: "codex", logicalRole: "IMPLEMENTER" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source-fingerprint",
    canonicalGitFingerprint: "sha256:git-fingerprint",
    delegatedPath: "/tmp/orchestra-implementation-parallel-member/workspace",
    syntheticBaselineSha: "1234567890abcdef",
    mutationScope: {
      allowedPaths: ["src/a/**"],
      forbiddenPaths: [".git/**", ".orchestra/state/**"],
    },
    changedPaths: ["src/a/example.mjs"],
    patchSha256: "sha256:patch",
    mutationDigest: "sha256:mutation",
    state: "READY_FOR_REVIEW",
    createdAt: "2026-10-15T13:00:00.000Z",
    parallelGroupId: "parallel-group-1",
    parallelMemberId: "local",
    ...overrides,
  };
}

function withRoot(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("bound member artifacts require paired group/member identities and round-trip", () => withRoot(
  "orchestra-parallel-member-artifact-",
  (root) => {
    const patch = Buffer.from("diff --git a/src/a/example.mjs b/src/a/example.mjs\n", "utf8");
    writeDelegationArtifact(root, { manifest: manifest(), patch });
    const read = readDelegationArtifact(root, "parallel-member-artifact");
    assert.equal(read.valid, true);
    assert.equal(read.manifest.parallelGroupId, "parallel-group-1");
    assert.equal(read.manifest.parallelMemberId, "local");

    const missingMember = manifest("missing-member");
    delete missingMember.parallelMemberId;
    assert.throws(
      () => writeDelegationArtifact(root, { manifest: missingMember, patch }),
      /DELEGATION_ARTIFACT_INVALID/,
    );

    const missingGroup = manifest("missing-group");
    delete missingGroup.parallelGroupId;
    assert.throws(
      () => writeDelegationArtifact(root, { manifest: missingGroup, patch }),
      /DELEGATION_ARTIFACT_INVALID/,
    );
  },
));

test("CONSUMED is valid only for an artifact bound to a parallel group", () => withRoot(
  "orchestra-parallel-member-consumed-",
  (root) => {
    const patch = Buffer.from("patch", "utf8");
    const bound = manifest("bound-consumed", { state: "CONSUMED" });
    writeDelegationArtifact(root, { manifest: bound, patch });
    assert.equal(readDelegationArtifact(root, "bound-consumed").manifest.state, "CONSUMED");

    const unbound = manifest("unbound-consumed", { state: "CONSUMED" });
    delete unbound.parallelGroupId;
    delete unbound.parallelMemberId;
    assert.throws(
      () => writeDelegationArtifact(root, { manifest: unbound, patch }),
      /DELEGATION_ARTIFACT_INVALID/,
    );
  },
));

test("ordinary artifact promotion cannot promote a parallel-bound member", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-parallel-member-promote-"));
  try {
    writeDelegationArtifact(root, {
      manifest: manifest(),
      patch: Buffer.from("patch", "utf8"),
    });
    const result = await promoteDelegationArtifact({
      repoRoot: root,
      artifactId: "parallel-member-artifact",
      generation: 7,
      actor: {
        provider: "codex",
        actorIdHash: "sha256:source-actor",
        actorKind: "ROOT",
        isRoot: true,
      },
    });
    assert.deepEqual(result, {
      promoted: false,
      reason: "CAPABILITY_DENIED",
      changedPaths: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful sibling artifact in a failed group becomes DISCARDED and records bounded cleanup", () => withRoot(
  "orchestra-parallel-member-failed-sibling-",
  (root) => {
    writeDelegationArtifact(root, {
      manifest: manifest("successful-sibling"),
      patch: Buffer.from("patch", "utf8"),
    });
    const transition = transitionDelegationArtifactState(root, "successful-sibling", {
      expectedState: "READY_FOR_REVIEW",
      nextState: "DISCARDED",
      cleanup: {
        cleaned: false,
        reason: "WORKSPACE_CLEANUP_FAILED",
        recoverablePath: "/tmp/orchestra-implementation-parallel-member/workspace",
      },
    });
    assert.equal(transition.transitioned, true);
    assert.equal(transition.manifest.state, "DISCARDED");

    const cleanup = recordDelegationArtifactCleanup(root, "successful-sibling", {
      cleaned: true,
      reason: null,
      recoverablePath: null,
    });
    assert.equal(cleanup.updated, true);
    assert.equal(cleanup.manifest.cleanup.cleaned, true);
    assert.notEqual(cleanup.manifest.state, "READY_FOR_REVIEW");
  },
));
