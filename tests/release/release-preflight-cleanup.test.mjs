import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("prepare workflow discards only disposable dist output before proving a clean immutable candidate", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const workflow = readFileSync(join(root, ".github/workflows/prepare-release.yml"), "utf8");

  assert.match(workflow, /id:\s*candidate/);
  assert.match(workflow, /sha=\$\(git rev-parse HEAD\).*GITHUB_OUTPUT/s);
  assert.match(workflow, /git diff --quiet HEAD -- \./);
  assert.match(workflow, /git diff --cached --quiet/);
  assert.match(workflow, /rm -rf dist/);
  assert.match(workflow, /git status --porcelain/);
  assert.match(workflow, /steps\.candidate\.outputs\.sha/);
  assert.match(workflow, /git rev-parse HEAD/);

  const preflightIndex = workflow.indexOf("- name: Run full prepared-release preflight");
  const cleanupIndex = workflow.indexOf("rm -rf dist");
  const cleanIndex = workflow.lastIndexOf("git status --porcelain");
  const pushIndex = workflow.indexOf("- name: Push validated release branch");

  assert.ok(preflightIndex !== -1 && cleanupIndex > preflightIndex, "dist cleanup must happen only after the full preflight");
  assert.ok(cleanIndex > cleanupIndex, "the workflow must require a fully clean worktree after deleting only dist/");
  assert.ok(pushIndex > cleanIndex, "no remote release branch may be pushed before the cleanup and clean-tree proof");
});
