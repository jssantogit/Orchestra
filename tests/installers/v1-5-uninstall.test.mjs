import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { buildRuntime } from "../../runtime/runtime-builder.mjs";
import { loadRuntimeManifest } from "../../runtime/manifest-loader.mjs";
import {
  installProjectRuntime,
  rollbackProjectRuntime,
  uninstallProjectRuntime,
} from "../../runtime/project-runtime-manager.mjs";

const scratch = mkdtempSync(join(tmpdir(), "orchestra-150-uninstall-"));
let runtimeManifest;
let builtRuntime;

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function project() {
  const root = mkdtempSync(join(scratch, "project-"));
  git(root, "init", "-q");
  writeFileSync(join(root, "README.md"), "original product\n");
  git(root, "add", "README.md");
  git(root, "-c", "user.name=Orchestra Test", "-c", "user.email=orchestra@example.invalid", "commit", "-qm", "baseline");
  return root;
}

before(async () => {
  runtimeManifest = await loadRuntimeManifest("codex");
  builtRuntime = join(scratch, "built-codex");
  await buildRuntime({ runtime: "codex", outputDir: builtRuntime });
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("uninstall dry-run is read-only and reports managed files without removing them", async () => {
  const root = project();
  await installProjectRuntime({ targetDir: root, runtimeManifest, builtRuntime });
  const hooks = join(root, ".codex", "hooks.json");
  const oldBytes = readFileSync(hooks, "utf8");
  const plan = await uninstallProjectRuntime({ targetDir: root, runtimeManifest, dryRun: true });
  assert.equal(plan.operation, "uninstall");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.changed, true);
  assert.equal(readFileSync(hooks, "utf8"), oldBytes);
  assert.ok(existsSync(join(root, ".orchestra", "state", "runtimes", "codex.json")));
});

test("uninstall removes only verified managed assets, preserves state, and can be rolled back from backup", async () => {
  const root = project();
  await installProjectRuntime({ targetDir: root, runtimeManifest, builtRuntime });
  const state = join(root, ".codex", "orchestra-state", "work.json");
  const lease = join(root, ".orchestra", "state", "work-lease.json");
  const user = join(root, "user-notes.txt");
  mkdirSync(join(root, ".codex", "orchestra-state"), { recursive: true });
  writeFileSync(state, "private state\n");
  writeFileSync(lease, JSON.stringify({ state: "CONTROL", capabilities: ["CONTROL"] }));
  writeFileSync(user, "keep this\n");
  const installed = await uninstallProjectRuntime({ targetDir: root, runtimeManifest });
  assert.equal(installed.operation, "uninstall");
  assert.ok(installed.backupId);
  assert.equal(existsSync(join(root, ".codex", "hooks.json")), false);
  assert.equal(existsSync(join(root, ".codex", "astra-orchestra")), false);
  assert.equal(existsSync(join(root, ".orchestra", "state", "runtimes", "codex.json")), false);
  assert.equal(readFileSync(state, "utf8"), "private state\n");
  assert.match(readFileSync(lease, "utf8"), /CONTROL/);
  assert.equal(readFileSync(user, "utf8"), "keep this\n");
  assert.equal(git(root, "status", "--short"), "?? user-notes.txt");
  const replay = await uninstallProjectRuntime({ targetDir: root, runtimeManifest });
  assert.equal(replay.operation, "noop");
  const restored = await rollbackProjectRuntime({ targetDir: root, runtimeManifest, backupId: installed.backupId });
  assert.equal(restored.operation, "rollback");
  assert.ok(existsSync(join(root, ".codex", "hooks.json")));
  assert.equal(readFileSync(state, "utf8"), "private state\n");
});

test("uninstall refuses managed file drift or missing ownership metadata", async () => {
  const root = project();
  await installProjectRuntime({ targetDir: root, runtimeManifest, builtRuntime });
  const hooks = join(root, ".codex", "hooks.json");
  writeFileSync(hooks, readFileSync(hooks, "utf8") + "\n// third party edit\n");
  await assert.rejects(
    uninstallProjectRuntime({ targetDir: root, runtimeManifest }),
    /RUNTIME_UNINSTALL_DRIFT/,
  );
  assert.match(readFileSync(hooks, "utf8"), /third party edit/);
  const missingOwner = project();
  mkdirSync(join(missingOwner, ".codex"), { recursive: true });
  writeFileSync(join(missingOwner, ".codex", "hooks.json"), "unowned\n");
  await assert.rejects(
    uninstallProjectRuntime({ targetDir: missingOwner, runtimeManifest }),
    /RUNTIME_UNINSTALL_UNMANAGED/,
  );
});

test("uninstall refuses active Work Lease writers even when legacy active-state file is missing", async () => {
  const root = project();
  await installProjectRuntime({ targetDir: root, runtimeManifest, builtRuntime });
  writeFileSync(join(root, ".orchestra", "state", "work-lease.json"), JSON.stringify({
    schema: "orchestra.work-lease.v1", state: "IMPLEMENTING", capabilities: ["WORKSPACE_EDIT"],
  }));
  await assert.rejects(
    uninstallProjectRuntime({ targetDir: root, runtimeManifest }),
    /RUNTIME_UNINSTALL_ACTIVE_WRITER/,
  );
  assert.ok(existsSync(join(root, ".codex", "hooks.json")));
});

test("uninstall in one linked worktree never removes another's runtime or shared ignore patterns", async () => {
  const main = project();
  const secondary = join(scratch, "secondary-worktree");
  git(main, "worktree", "add", "-b", "feature-isolated", secondary, "HEAD");
  await installProjectRuntime({ targetDir: main, runtimeManifest, builtRuntime });
  await installProjectRuntime({ targetDir: secondary, runtimeManifest, builtRuntime });
  const exclude = git(main, "rev-parse", "--git-path", "info/exclude");
  const excludePath = isAbsolute(exclude) ? exclude : resolve(main, exclude);
  const sharedBefore = readFileSync(excludePath, "utf8");
  await uninstallProjectRuntime({ targetDir: secondary, runtimeManifest });
  assert.ok(existsSync(join(main, ".codex", "hooks.json")));
  assert.equal(existsSync(join(secondary, ".codex", "hooks.json")), false);
  const sharedAfter = readFileSync(excludePath, "utf8");
  assert.equal(sharedAfter, sharedBefore);
  assert.match(sharedAfter, /orchestra managed state/);
});
