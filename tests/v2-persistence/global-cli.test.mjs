import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "v2", "global", "orchestra.mjs");

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeGitRepo(root, name) {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  git("init", repo);
  return repo;
}

async function withSandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-global-cli-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runCli({ home, cwd, args = [] }) {
  const result = spawnSync(process.execPath, [cli, ...args, "--home", home], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return {
    status: result.status,
    stdout,
    stderr,
    json: stdout ? JSON.parse(stdout) : null,
    errorJson: stderr ? JSON.parse(stderr) : null,
  };
}

async function topLevelEntries(path) {
  return (await readdir(path)).sort();
}

test("global CLI reports the selected Orchestra Home without touching a project", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "orchestra-home");
    const result = runCli({ home, cwd: root, args: ["home"] });

    assert.equal(result.status, 0);
    assert.deepEqual(result.json, { ok: true, home });
    assert.equal(result.stderr, "");
  });
});

test("register from a nested path persists globally and status resolves from a fresh process", async () => {
  await withSandbox(async (root) => {
    const repo = await makeGitRepo(root, "repo");
    const nested = join(repo, "src", "feature");
    await mkdir(nested, { recursive: true });
    const before = await topLevelEntries(repo);
    const home = join(root, "orchestra-home");

    const registered = runCli({
      home,
      cwd: nested,
      args: [
        "register",
        "--runtime-image", "2.0.0",
        "--instruction-epoch", "1",
        "--trust", "trusted",
      ],
    });

    assert.equal(registered.status, 0);
    assert.equal(registered.json.ok, true);
    assert.equal(registered.json.replayed, false);
    assert.match(registered.json.project.projectId, /^prj_[0-9a-f-]{36}$/);
    assert.equal(registered.json.project.runtime.pinnedImage, "2.0.0");
    assert.deepEqual(await topLevelEntries(repo), before);

    const byWorkspace = runCli({ home, cwd: nested, args: ["project", "status"] });
    assert.equal(byWorkspace.status, 0);
    assert.equal(byWorkspace.json.ok, true);
    assert.equal(byWorkspace.json.registered, true);
    assert.equal(byWorkspace.json.project.projectId, registered.json.project.projectId);

    const byId = runCli({
      home,
      cwd: root,
      args: ["project", "status", registered.json.project.projectId],
    });
    assert.equal(byId.status, 0);
    assert.equal(byId.json.project.projectId, registered.json.project.projectId);
  });
});

test("register is idempotent across CLI processes", async () => {
  await withSandbox(async (root) => {
    const repo = await makeGitRepo(root, "repo");
    const home = join(root, "orchestra-home");
    const args = [
      "register", repo,
      "--runtime-image", "2.0.0",
      "--instruction-epoch", "4",
      "--trust", "trusted",
    ];

    const first = runCli({ home, cwd: root, args });
    const replay = runCli({ home, cwd: root, args });

    assert.equal(first.status, 0);
    assert.equal(first.json.replayed, false);
    assert.equal(replay.status, 0);
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.project.projectId, first.json.project.projectId);
  });
});

test("project status for an unregistered Git workspace is factual and non-destructive", async () => {
  await withSandbox(async (root) => {
    const repo = await makeGitRepo(root, "repo");
    const before = await topLevelEntries(repo);
    const result = runCli({ home: join(root, "home"), cwd: repo, args: ["project", "status"] });

    assert.equal(result.status, 1);
    assert.deepEqual(result.json, { ok: false, reason: "PROJECT_NOT_REGISTERED", registered: false });
    assert.equal(result.stderr, "");
    assert.deepEqual(await topLevelEntries(repo), before);
  });
});

test("project rebind follows an explicitly moved repository", async () => {
  await withSandbox(async (root) => {
    const original = await makeGitRepo(root, "repo-original");
    const moved = join(root, "repo-moved");
    const home = join(root, "home");
    const registered = runCli({
      home,
      cwd: root,
      args: [
        "register", original,
        "--runtime-image", "2.0.0",
        "--instruction-epoch", "1",
        "--trust", "trusted",
      ],
    });
    assert.equal(registered.status, 0);

    await rename(original, moved);
    const rebound = runCli({
      home,
      cwd: root,
      args: ["project", "rebind", registered.json.project.projectId, moved],
    });

    assert.equal(rebound.status, 0);
    assert.equal(rebound.json.ok, true);
    assert.equal(rebound.json.replayed, false);
    assert.equal(rebound.json.project.projectId, registered.json.project.projectId);

    const status = runCli({ home, cwd: moved, args: ["project", "status"] });
    assert.equal(status.status, 0);
    assert.equal(status.json.project.projectId, registered.json.project.projectId);
  });
});

test("usage and runtime failures are structured on stderr with exit 2", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const usage = runCli({ home, cwd: root, args: ["unknown-command"] });
    assert.equal(usage.status, 2);
    assert.equal(usage.stdout, "");
    assert.equal(usage.errorJson.ok, false);
    assert.equal(usage.errorJson.code, "ORCHESTRA_V2_CLI_USAGE");

    const missingRoot = runCli({
      home,
      cwd: root,
      args: [
        "register", join(root, "does-not-exist"),
        "--runtime-image", "2.0.0",
        "--instruction-epoch", "1",
        "--trust", "trusted",
      ],
    });
    assert.equal(missingRoot.status, 2);
    assert.equal(missingRoot.stdout, "");
    assert.equal(missingRoot.errorJson.code, "ORCHESTRA_PROJECT_ROOT_UNAVAILABLE");
  });
});
