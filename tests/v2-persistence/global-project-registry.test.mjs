import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import {
  createGlobalProjectRegistry,
  resolveOrchestraHome,
} from "../../v2/global/project-registry.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeGitRepo(root, name) {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  git("init", repo);
  return repo;
}

async function topLevelEntries(path) {
  return (await readdir(path)).sort();
}

async function withSandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-global-registry-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Orchestra Home is user-global and platform-local rather than project-local", () => {
  assert.equal(
    resolveOrchestraHome({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\Joao\\AppData\\Local" },
      homeDir: "C:\\Users\\Joao",
    }),
    win32.join("C:\\Users\\Joao\\AppData\\Local", "Orchestra"),
  );
  assert.equal(
    resolveOrchestraHome({ platform: "linux", env: { XDG_DATA_HOME: "/data/user" }, homeDir: "/home/user" }),
    posix.join("/data/user", "orchestra"),
  );
  assert.equal(
    resolveOrchestraHome({ platform: "linux", env: {}, homeDir: "/home/user" }),
    posix.join("/home/user", ".local", "share", "orchestra"),
  );
  assert.equal(
    resolveOrchestraHome({ platform: "darwin", env: {}, homeDir: "/Users/user" }),
    posix.join("/Users/user", "Library", "Application Support", "Orchestra"),
  );
});

test("registerWorkspace canonicalizes a nested path to Git top-level and writes no Orchestra files into the repo", async () => {
  await withSandbox(async (root) => {
    const repo = await makeGitRepo(root, "repo");
    const nested = join(repo, "src", "feature");
    await mkdir(nested, { recursive: true });
    const before = await topLevelEntries(repo);
    const home = join(root, "global-orchestra-home");
    const registry = createGlobalProjectRegistry({ home });

    try {
      const result = await registry.registerWorkspace({
        root: nested,
        runtimeImage: "2.0.0",
        instructionEpoch: 1,
        trustMode: "trusted",
      });

      assert.equal(result.ok, true);
      assert.equal(result.replayed, false);
      assert.match(result.project.projectId, /^prj_[0-9a-f-]{36}$/);
      assert.match(result.project.lineageId, /^lineage_[0-9a-f-]{36}$/);
      assert.equal(result.project.workspace.canonicalRoot, await realpath(repo));
      assert.deepEqual(await topLevelEntries(repo), before);
      assert.equal((await topLevelEntries(repo)).includes(".orchestra"), false);
      assert.equal((await topLevelEntries(repo)).includes(".codex"), false);
      assert.equal((await topLevelEntries(repo)).includes(".agents"), false);
    } finally {
      registry.close();
    }
  });
});

test("registering the same workspace twice is idempotent and survives registry reopen", async () => {
  await withSandbox(async (root) => {
    const repo = await makeGitRepo(root, "repo");
    const home = join(root, "home");
    const firstRegistry = createGlobalProjectRegistry({ home });
    const first = await firstRegistry.registerWorkspace({
      root: repo,
      runtimeImage: "2.0.0",
      instructionEpoch: 1,
      trustMode: "trusted",
    });
    firstRegistry.close();

    const reopened = createGlobalProjectRegistry({ home });
    try {
      const replay = await reopened.registerWorkspace({
        root: repo,
        runtimeImage: "9.9.9-ignored-on-replay",
        instructionEpoch: 999,
        trustMode: "ignored-on-replay",
      });
      const resolved = await reopened.resolveWorkspace(join(repo, ".git"));

      assert.equal(replay.ok, true);
      assert.equal(replay.replayed, true);
      assert.equal(replay.project.projectId, first.project.projectId);
      assert.equal(replay.project.runtime.pinnedImage, "2.0.0");
      assert.equal(resolved.projectId, first.project.projectId);
    } finally {
      reopened.close();
    }
  });
});

test("two independent repositories with the same remote remain distinct project lineages", async () => {
  await withSandbox(async (root) => {
    const repoA = await makeGitRepo(root, "repo-a");
    const repoB = await makeGitRepo(root, "repo-b");
    const remote = "https://example.invalid/same/repository.git";
    git("-C", repoA, "remote", "add", "origin", remote);
    git("-C", repoB, "remote", "add", "origin", remote);
    const registry = createGlobalProjectRegistry({ home: join(root, "home") });

    try {
      const a = await registry.registerWorkspace({ root: repoA, runtimeImage: "2.0.0", instructionEpoch: 1, trustMode: "trusted" });
      const b = await registry.registerWorkspace({ root: repoB, runtimeImage: "2.0.0", instructionEpoch: 1, trustMode: "trusted" });

      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.notEqual(a.project.projectId, b.project.projectId);
      assert.notEqual(a.project.lineageId, b.project.lineageId);
    } finally {
      registry.close();
    }
  });
});

test("rebindWorkspace follows an explicitly moved repository without requiring the old path to exist", async () => {
  await withSandbox(async (root) => {
    const repo = await makeGitRepo(root, "repo-old");
    const moved = join(root, "repo-new");
    const registry = createGlobalProjectRegistry({ home: join(root, "home") });

    try {
      const registered = await registry.registerWorkspace({ root: repo, runtimeImage: "2.0.0", instructionEpoch: 1, trustMode: "trusted" });
      await rename(repo, moved);

      const rebound = await registry.rebindWorkspace({ projectId: registered.project.projectId, newRoot: moved });
      assert.equal(rebound.ok, true);
      assert.equal(rebound.project.workspace.canonicalRoot, await realpath(moved));
      assert.equal((await registry.resolveWorkspace(moved)).projectId, registered.project.projectId);
    } finally {
      registry.close();
    }
  });
});

test("non-Git workspace fails with a structured registration error and creates no local runtime", async () => {
  await withSandbox(async (root) => {
    const plain = join(root, "plain");
    await mkdir(plain, { recursive: true });
    const registry = createGlobalProjectRegistry({ home: join(root, "home") });

    try {
      await assert.rejects(
        registry.registerWorkspace({ root: plain, runtimeImage: "2.0.0", instructionEpoch: 1, trustMode: "trusted" }),
        (error) => error?.code === "ORCHESTRA_PROJECT_NOT_GIT",
      );
      assert.deepEqual(await topLevelEntries(plain), []);
    } finally {
      registry.close();
    }
  });
});
