import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-workspace-fingerprint-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

test("tracked, untracked, index, and HEAD changes alter workspace fingerprint", () => {
  const root = repo();
  const clean = readWorkspaceFingerprint(root);
  assert.equal(clean.available, true);
  assert.equal(clean.dirtyFileCount, 0);

  writeFileSync(join(root, "tracked.txt"), "two\n");
  const dirty = readWorkspaceFingerprint(root);
  assert.notEqual(dirty.fingerprint, clean.fingerprint);

  writeFileSync(join(root, "untracked.txt"), "u\n");
  const untracked = readWorkspaceFingerprint(root);
  assert.notEqual(untracked.fingerprint, dirty.fingerprint);

  git(root, "add", "tracked.txt");
  const staged = readWorkspaceFingerprint(root);
  assert.notEqual(staged.indexHash, clean.indexHash);
  assert.notEqual(staged.fingerprint, untracked.fingerprint);

  git(root, "add", "untracked.txt");
  git(root, "commit", "-m", "second");
  const committed = readWorkspaceFingerprint(root);
  assert.notEqual(committed.head, clean.head);
  assert.notEqual(committed.fingerprint, clean.fingerprint);
});

test("excluded Orchestra governance state does not affect product fingerprint", () => {
  const root = repo();
  const before = readWorkspaceFingerprint(root, { excludedPaths: [".orchestra/state/**"] });
  mkdirSync(join(root, ".orchestra", "state"), { recursive: true });
  writeFileSync(join(root, ".orchestra", "state", "work-lease.json"), "{}\n");
  const after = readWorkspaceFingerprint(root, { excludedPaths: [".orchestra/state/**"] });
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(after.dirtyFileCount, before.dirtyFileCount);
});

test("returns deterministic unavailable identity outside git", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-no-git-"));
  const first = readWorkspaceFingerprint(root);
  const second = readWorkspaceFingerprint(root);
  assert.equal(first.available, false);
  assert.equal(first.fingerprint, second.fingerprint);
});
