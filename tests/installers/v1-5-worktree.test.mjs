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
