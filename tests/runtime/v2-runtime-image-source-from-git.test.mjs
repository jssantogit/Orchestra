import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildRuntimeImageSourceFromGit } from "../../v2/runtime-images/source-from-git.mjs";
import { loadRuntimeImageSource } from "../../v2/runtime-images/source.mjs";
import { createRuntimeImageStore } from "../../v2/runtime-images/store.mjs";
import { collectPosixReadiness } from "../../scripts/collect-posix-readiness.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function withGitRepo(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-runtime-image-source-"));
  try {
    git(root, "init");
    git(root, "config", "user.name", "Orchestra Test");
    git(root, "config", "user.email", "orchestra-test@example.invalid");
    await mkdir(join(root, "v2", "nested"), { recursive: true });
    await writeFile(join(root, "v2", "runtime.mjs"), "export const value = 'v2';\n");
    await writeFile(join(root, "v2", "nested", "adapter.mjs"), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(root, "README.md"), "not part of the runtime image\n");
    git(root, "add", "--all");
    git(root, "commit", "-m", "fixture");
    await fn({ root, head: git(root, "rev-parse", "HEAD") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("runtime image source is derived from exact tracked v2 blobs and binds its candidate head", async () => {
  await withGitRepo(async ({ root, head }) => {
    const source = buildRuntimeImageSourceFromGit({ repoRoot: root, expectedHeadSha: head });
    const files = new Map(source.files.map((file) => [file.path, Buffer.from(file.contentBase64, "base64")]));

    assert.deepEqual([...files.keys()], ["candidate-head.json", "v2/nested/adapter.mjs", "v2/runtime.mjs"]);
    assert.deepEqual(files.get("v2/nested/adapter.mjs"), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(JSON.parse(files.get("candidate-head.json").toString("utf8")), { headSha: head });
    assert.equal(source.schema, "orchestra.runtime-image-source.v2");
    assert.equal(source.version, "2.0.0");
    assert.deepEqual(source.engineCompatibility, { min: "2.0.0", max: "2.x" });
    assert.deepEqual(source.providerAdapterCompatibility, {
      codex: { min: "2.0.0", max: "2.x" },
      antigravity: { min: "2.0.0", max: "2.x" },
    });
  });
});

test("runtime image source rejects a requested SHA other than the checked-out HEAD", async () => {
  await withGitRepo(async ({ root }) => {
    assert.throws(
      () => buildRuntimeImageSourceFromGit({ repoRoot: root, expectedHeadSha: "0".repeat(40) }),
      (error) => error?.code === "ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_HEAD_MISMATCH",
    );
  });
});

test("runtime image source rejects dirty and untracked source trees", async () => {
  await withGitRepo(async ({ root, head }) => {
    await writeFile(join(root, "v2", "runtime.mjs"), "changed worktree bytes\n");
    assert.throws(
      () => buildRuntimeImageSourceFromGit({ repoRoot: root, expectedHeadSha: head }),
      (error) => error?.code === "ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_DIRTY",
    );
    await writeFile(join(root, "v2", "runtime.mjs"), "export const value = 'v2';\n");
    await writeFile(join(root, "v2", "untracked.mjs"), "export const untracked = true;\n");
    assert.throws(
      () => buildRuntimeImageSourceFromGit({ repoRoot: root, expectedHeadSha: head }),
      (error) => error?.code === "ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_DIRTY",
    );
  });
});

test("runtime image source rejects symlink entries in the tracked v2 tree", async () => {
  await withGitRepo(async ({ root }) => {
    const target = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      input: "outside-target",
      encoding: "utf8",
    }).trim();
    git(root, "update-index", "--add", "--cacheinfo", `120000,${target},v2/linked.mjs`);
    git(root, "config", "core.symlinks", "false");
    git(root, "commit", "-m", "symlink fixture");
    const head = git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "v2", "linked.mjs"), "outside-target");

    assert.throws(
      () => buildRuntimeImageSourceFromGit({ repoRoot: root, expectedHeadSha: head }),
      (error) => error?.code === "ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_ENTRY_INVALID",
    );
  });
});

test("source-derived image identity is stable across isolated homes", async () => {
  await withGitRepo(async ({ root, head }) => {
    const source = buildRuntimeImageSourceFromGit({ repoRoot: root, expectedHeadSha: head });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "orchestra-runtime-image-derived-"));
    const sourcePath = join(temporaryRoot, "runtime-image-source.json");
    const firstHome = await mkdtemp(join(tmpdir(), "orchestra-runtime-image-home-a-"));
    const secondHome = await mkdtemp(join(tmpdir(), "orchestra-runtime-image-home-b-"));
    try {
      await writeFile(sourcePath, JSON.stringify(source));
      const input = await loadRuntimeImageSource(sourcePath);
      const first = await createRuntimeImageStore({ orchestraHome: firstHome }).install(input);
      const second = await createRuntimeImageStore({ orchestraHome: secondHome }).install(input);
      assert.equal(first.imageId, second.imageId);
      assert.equal((await createRuntimeImageStore({ orchestraHome: firstHome }).verify(first.imageId)).valid, true);
      assert.equal((await createRuntimeImageStore({ orchestraHome: secondHome }).verify(second.imageId)).valid, true);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
      await rm(firstHome, { recursive: true, force: true });
      await rm(secondHome, { recursive: true, force: true });
    }
  });
});

test("POSIX collector rejects an output directory inside its source checkout", async () => {
  await withGitRepo(async ({ root, head }) => {
    await assert.rejects(
      collectPosixReadiness({ repoRoot: root, expectedHeadSha: head, outputDir: join(root, "output") }),
      (error) => error instanceof TypeError && error.message === "--output-dir must be outside the repository",
    );
  });
});

test("POSIX collector refuses to build from a revision other than the expected head", async () => {
  await withGitRepo(async ({ root }) => {
    const outputRoot = await mkdtemp(join(tmpdir(), "orchestra-posix-collector-output-"));
    try {
      await assert.rejects(
        collectPosixReadiness({
          repoRoot: root,
          expectedHeadSha: "0".repeat(40),
          outputDir: join(outputRoot, "result"),
        }),
        (error) => error?.code === "ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_HEAD_MISMATCH",
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
