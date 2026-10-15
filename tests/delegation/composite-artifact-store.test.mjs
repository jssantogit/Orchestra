import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listCompositeArtifacts,
  readCompositeArtifact,
  writeCompositeArtifact,
} from "../../runtime/delegation/composite-artifact-store.mjs";

function manifest(id = "composite-one") {
  return {
    schema: "orchestra.parallel-composite-artifact.v1",
    artifactId: id,
    groupId: "group-compose-1",
    taskId: "task-compose",
    generation: 7,
    source: { provider: "codex", actorIdHash: "sha256:root" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
    delegatedPath: "/tmp/orchestra-implementation-composition/workspace",
    syntheticBaselineSha: "1234567890abcdef",
    memberArtifactIds: ["artifact-a", "artifact-b"],
    changedPaths: ["app/home.txt", "app/library.txt"],
    patchSha256: "sha256:patch",
    mutationDigest: "sha256:mutation",
    state: "READY_FOR_REVIEW",
    createdAt: "2026-10-15T14:00:00.000Z",
  };
}

test("composite artifact store atomically round-trips one bounded two-member artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-composite-store-"));
  try {
    const patch = Buffer.from("diff --git a/app/home.txt b/app/home.txt\n", "utf8");
    const written = writeCompositeArtifact(root, { manifest: manifest(), patch });
    assert.equal(written.manifest.artifactId, "composite-one");
    assert.equal(written.patch.equals(patch), true);

    const read = readCompositeArtifact(root, "composite-one");
    assert.equal(read.exists, true);
    assert.equal(read.valid, true);
    assert.deepEqual(read.manifest, manifest());
    assert.equal(read.patch.equals(patch), true);
    assert.deepEqual(listCompositeArtifacts(root).map((item) => item.artifactId), ["composite-one"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composite artifact store fails closed on unsafe IDs, wrong member cardinality, and narrative leakage", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-composite-store-invalid-"));
  try {
    for (const id of ["", ".", "..", "../escape", "a/b", "a\\b"]) {
      assert.throws(() => readCompositeArtifact(root, id), /COMPOSITE_ARTIFACT_ID_INVALID/);
    }

    for (const memberArtifactIds of [[], ["artifact-a"], ["artifact-a", "artifact-a"], ["a", "b", "c"]]) {
      const invalid = manifest("composite-members");
      invalid.memberArtifactIds = memberArtifactIds;
      assert.throws(
        () => writeCompositeArtifact(root, { manifest: invalid, patch: Buffer.from("patch") }),
        /COMPOSITE_ARTIFACT_INVALID/,
      );
    }

    for (const field of ["prompt", "transcript", "reasoning", "stdout", "stderr", "workerReport"]) {
      const invalid = manifest(`composite-${field}`);
      invalid[field] = "forbidden";
      assert.throws(
        () => writeCompositeArtifact(root, { manifest: invalid, patch: Buffer.from("patch") }),
        /COMPOSITE_ARTIFACT_INVALID/,
        field,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
