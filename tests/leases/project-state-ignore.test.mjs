import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureProjectStateIgnored } from "../../runtime/project-state-ignore.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-project-state-ignore-"));
  git(root, "init");
  return root;
}

test("managed state is hidden without changing tracked gitignore", () => {
  const root = repo();
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  const result = ensureProjectStateIgnored(root);
  assert.equal(result.changed, true);
  mkdirSync(join(root, ".orchestra", "state"), { recursive: true });
  writeFileSync(join(root, ".orchestra", "state", "work-lease.json"), "{}\n");
  assert.equal(git(root, "status", "--short", "--", ".orchestra/state"), "");
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "dist/\n");
});

test("existing info exclude content is preserved and updates are idempotent", () => {
  const root = repo();
  const exclude = join(root, ".git", "info", "exclude");
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  writeFileSync(exclude, "# user rule\n*.local\n");
  const first = ensureProjectStateIgnored(root);
  const once = readFileSync(exclude, "utf8");
  const second = ensureProjectStateIgnored(root);
  const twice = readFileSync(exclude, "utf8");
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(twice, once);
  assert.match(once, /^# user rule\n\*\.local\n/);
  assert.match(once, /\.orchestra\/state\/\*\*/);
});

test("linked git worktrees share the repository exclude and keep managed state hidden", () => {
  const root = repo();
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "-c", "user.name=Orchestra Test", "-c", "user.email=orchestra@example.invalid", "commit", "-qm", "fixture");
  const worktree = join(tmpdir(), `orchestra-project-state-worktree-${process.pid}-${Date.now()}`);
  git(root, "worktree", "add", "-q", "-b", `orchestra-ignore-${process.pid}-${Date.now()}`, worktree);

  const result = ensureProjectStateIgnored(worktree);
  assert.equal(result.changed, true);
  mkdirSync(join(worktree, ".orchestra", "state"), { recursive: true });
  writeFileSync(join(worktree, ".orchestra", "state", "work-lease.json"), "{}\n");
  assert.equal(git(worktree, "status", "--short", "--", ".orchestra/state"), "");
  assert.match(readFileSync(join(root, ".git", "info", "exclude"), "utf8"), /\.orchestra\/state\/\*\*/);
});

test("non-git target does not get synthetic .git metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-project-state-no-git-"));
  const result = ensureProjectStateIgnored(root);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "GIT_METADATA_UNAVAILABLE");
  assert.equal(result.path, null);
  assert.equal(existsSync(join(root, ".git")), false);
});

test("managed delegation payload is ignored without concealing user .orchestra files", () => {
  const root = repo();
  ensureProjectStateIgnored(root);
  mkdirSync(join(root, ".orchestra", "runtime", "delegation"), { recursive: true });
  writeFileSync(join(root, ".orchestra", "runtime", "delegation", "cli.mjs"), "managed\n");
  assert.equal(git(root, "status", "--short", "--", ".orchestra/runtime/delegation"), "");
  writeFileSync(join(root, ".orchestra", "user-note.txt"), "keep visible\n");
  assert.match(git(root, "status", "--short", "--", ".orchestra"), /user-note.txt|\.orchestra\//);
  assert.match(git(root, "status", "--short", "--untracked-files=all"), /user-note\.txt/);
});
