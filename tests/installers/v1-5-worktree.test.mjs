import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const worktreeCli = join(root, "scripts", "orchestra-worktree.mjs");
const codexCli = join(root, "scripts", "orchestra-codex-project.mjs");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function call(file, args) {
  return spawnSync(process.execPath, [file, ...args], { encoding: "utf8", timeout: 60_000 });
}

function makeRepository(parent) {
  const repo = join(parent, "repository");
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "product.txt"), "original source\n");
  git(repo, "add", "product.txt");
  git(repo, "-c", "user.name=Orchestra Test", "-c", "user.email=orchestra@example.invalid", "commit", "-qm", "source");
  return repo;
}

test("temporary worktree lifecycle installs separate Codex runtimes without altering original checkout", () => {
  const scratch = mkdtempSync(join(tmpdir(), "orchestra-worktree-cli-"));
  try {
    const repo = makeRepository(scratch);
    const a = join(scratch, "task-a");
    const b = join(scratch, "task-b");
    const base = git(repo, "rev-parse", "HEAD");
    for (const [dir, name] of [[a, "test/orchestra-task-a"], [b, "test/orchestra-task-b"]]) {
      const created = call(worktreeCli, ["create", "--repo", repo, "--path", dir, "--branch", name, "--from", base]);
      assert.equal(created.status, 0, created.stderr || created.stdout);
      assert.equal(JSON.parse(created.stdout).ok, true);
      assert.ok(existsSync(join(dir, ".codex", "hooks.json")));
      assert.equal(git(dir, "rev-parse", "HEAD"), base);
    }
    const listed = call(worktreeCli, ["list", "--repo", repo]);
    assert.equal(listed.status, 0, listed.stderr);
    const worktrees = JSON.parse(listed.stdout).worktrees;
    assert.ok(worktrees.some((item) => item.root === a));
    assert.ok(worktrees.some((item) => item.root === b));
    const doctor = call(worktreeCli, ["doctor", "--path", b]);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    assert.equal(JSON.parse(doctor.stdout).healthy, true);

    const removed = call(codexCli, ["uninstall", a, "--json"]);
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    assert.equal(JSON.parse(removed.stdout).statePreserved, true);
    assert.ok(!existsSync(join(a, ".codex", "hooks.json")));
    assert.ok(existsSync(join(b, ".codex", "hooks.json")));
    assert.equal(readFileSync(join(repo, "product.txt"), "utf8"), "original source\n");
    assert.equal(git(repo, "status", "--short"), "");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("temporary create refuses an existing directory without changing Git branches or files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "orchestra-worktree-refuse-"));
  try {
    const repo = makeRepository(scratch);
    const destination = join(scratch, "already-exists");
    mkdirSync(destination);
    writeFileSync(join(destination, "private.txt"), "must survive\n");
    const before = git(repo, "branch", "--list");
    const result = call(worktreeCli, ["create", "--repo", repo, "--path", destination, "--branch", "test/denied", "--from", "HEAD"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WORKTREE_TARGET_EXISTS/);
    assert.equal(readFileSync(join(destination, "private.txt"), "utf8"), "must survive\n");
    assert.equal(git(repo, "branch", "--list"), before);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("worktree uninstall dry-run is read-only and actual uninstall preserves worktree and peers", () => {
  const scratch = mkdtempSync(join(tmpdir(), "orchestra-worktree-uninstall-"));
  try {
    const repo = makeRepository(scratch);
    const a = join(scratch, "task-a");
    const b = join(scratch, "task-b");
    const base = git(repo, "rev-parse", "HEAD");
    for (const [dir, name] of [[a, "test/temp-a"], [b, "test/temp-b"]]) {
      const created = call(worktreeCli, ["create", "--repo", repo, "--path", dir, "--branch", name, "--from", base]);
      assert.equal(created.status, 0, created.stderr || created.stdout);
    }

    const preview = call(worktreeCli, ["uninstall", "--path", a, "--dry-run"]);
    assert.equal(preview.status, 0, preview.stderr || preview.stdout);
    assert.equal(JSON.parse(preview.stdout).dryRun, true);
    assert.equal(JSON.parse(preview.stdout).changed, true);
    assert.ok(existsSync(join(a, ".codex", "hooks.json")));

    const removed = call(worktreeCli, ["uninstall", "--path", a]);
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    const result = JSON.parse(removed.stdout);
    assert.equal(result.operation, "uninstall");
    assert.equal(result.statePreserved, true);
    assert.ok(existsSync(a));
    assert.equal(git(a, "rev-parse", "HEAD"), base);
    assert.equal(existsSync(join(a, ".codex", "hooks.json")), false);
    assert.equal(existsSync(join(b, ".codex", "hooks.json")), true);
    assert.equal(git(repo, "status", "--short"), "");

    const again = call(worktreeCli, ["uninstall", "--path", a]);
    assert.equal(again.status, 0, again.stderr || again.stdout);
    assert.equal(JSON.parse(again.stdout).changed, false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("worktree uninstall refuses non-root paths and does not uninstall their root runtime", () => {
  const scratch = mkdtempSync(join(tmpdir(), "orchestra-worktree-root-only-"));
  try {
    const repo = makeRepository(scratch);
    const child = join(repo, "nested");
    mkdirSync(child);
    const before = call(worktreeCli, ["uninstall", "--path", child]);
    assert.notEqual(before.status, 0);
    assert.match(before.stderr, /WORKTREE_REPOSITORY_ROOT_REQUIRED/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
