import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listDelegationArtifacts,
  readDelegationArtifact,
  writeDelegationArtifact,
} from "../../runtime/delegation/artifact-store.mjs";

function manifest(id = "artifact-one") {
  return {
    schema: "orchestra.delegation-artifact.v1",
    artifactId: id,
    delegationId: "delegation-one",
    taskId: "task-one",
    generation: 7,
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "IMPLEMENTER" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source-fingerprint",
    canonicalGitFingerprint: "sha256:git-boundary",
    delegatedPath: "/tmp/orchestra-artifact-workspace",
    syntheticBaselineSha: "1234567890abcdef",
    mutationScope: {
      allowedPaths: ["src/**"],
      forbiddenPaths: [".git/**", ".orchestra/state/**"],
    },
    changedPaths: ["src/example.mjs"],
    patchSha256: "sha256:patch",
    mutationDigest: "sha256:mutation",
    state: "READY_FOR_REVIEW",
    createdAt: "2026-10-15T03:00:00.000Z",
  };
}

test("artifact store atomically round-trips bounded manifest and patch", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-artifact-store-"));
  try {
    const patch = Buffer.from("diff --git a/src/example.mjs b/src/example.mjs\n", "utf8");
    const written = writeDelegationArtifact(root, { manifest: manifest(), patch });
    assert.equal(written.manifest.artifactId, "artifact-one");
    assert.equal(written.patch.equals(patch), true);

    const read = readDelegationArtifact(root, "artifact-one");
    assert.equal(read.exists, true);
    assert.equal(read.valid, true);
    assert.deepEqual(read.manifest, manifest());
    assert.equal(read.patch.equals(patch), true);
    assert.deepEqual(listDelegationArtifacts(root).map((item) => item.artifactId), ["artifact-one"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact store rejects traversal, unsafe IDs, raw model channels, and malformed state", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-artifact-store-invalid-"));
  try {
    for (const id of ["", ".", "..", "../escape", "a/b", "a\\b"]) {
      assert.throws(() => readDelegationArtifact(root, id), /ARTIFACT_ID_INVALID/);
    }

    for (const field of ["prompt", "transcript", "reasoning", "stdout", "stderr", "workerReport"]) {
      const invalid = manifest(`artifact-${field}`);
      invalid[field] = "forbidden";
      assert.throws(
        () => writeDelegationArtifact(root, { manifest: invalid, patch: Buffer.from("patch") }),
        /DELEGATION_ARTIFACT_INVALID/,
        field,
      );
    }

    const badState = manifest("artifact-bad-state");
    badState.state = "ACCEPTED";
    assert.throws(
      () => writeDelegationArtifact(root, { manifest: badState, patch: Buffer.from("patch") }),
      /DELEGATION_ARTIFACT_INVALID/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
