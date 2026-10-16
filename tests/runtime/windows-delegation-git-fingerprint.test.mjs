import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDelegationProductFingerprint } from "../../runtime/delegation/source-snapshot.mjs";
import { readDelegationGitBoundary } from "../../runtime/delegation/git-boundary.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-windows-delegation-fingerprint-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "baseline\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

test("Windows delegation product fingerprint remains available with sanitized Git config", { skip: process.platform !== "win32" }, (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const expectedHead = git(repoRoot, "rev-parse", "HEAD");
  const fingerprint = readDelegationProductFingerprint(repoRoot);

  assert.equal(fingerprint.available, true);
  assert.equal(fingerprint.head, expectedHead);
  assert.equal(fingerprint.dirtyFileCount, 0);
  assert.match(fingerprint.fingerprint, /^[0-9a-f]{64}$/);
});

test("Windows delegation Git boundary remains available with sanitized Git config", { skip: process.platform !== "win32" }, async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const boundary = await readDelegationGitBoundary(repoRoot);

  assert.equal(boundary.available, true);
  assert.match(boundary.fingerprint, /^[0-9a-f]{64}$/);
});
