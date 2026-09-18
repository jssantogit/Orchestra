import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANAGED_RUNTIME_PATHS,
  PRESERVED_PROJECT_PATHS,
} from "../../runtimes/antigravity/.agents/skills/orchestra/project-runtime-manager.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const manager = readFileSync(resolve(root, "runtimes/antigravity/.agents/skills/orchestra/project-runtime-manager.mjs"), "utf8");

test("ARCH-RUNTIME-01: managed boundary excludes project state and Dream history", () => {
  assert.deepEqual([...MANAGED_RUNTIME_PATHS], [
    ".agents/agents",
    ".agents/hooks",
    ".agents/skills",
    ".agents/dream",
    ".agents/hooks.json",
    "GEMINI.md",
  ]);
  for (const forbidden of [".agents/state", ".agents/telemetry", ".agents/dream-data", ".agents/artifacts", ".agents/rules"]) {
    assert.equal(MANAGED_RUNTIME_PATHS.includes(forbidden), false);
    assert.equal(PRESERVED_PROJECT_PATHS.includes(forbidden), true);
  }
});

test("ARCH-RUNTIME-02: update backs up before destructive managed replacement", () => {
  const updateStart = manager.indexOf("export function updateProjectRuntime");
  const rollbackStart = manager.indexOf("export function rollbackProjectRuntime");
  const updateBody = manager.slice(updateStart, rollbackStart);
  assert.ok(updateBody.indexOf("createRuntimeBackup(") >= 0);
  assert.ok(updateBody.indexOf("removeManagedRuntime(") > updateBody.indexOf("createRuntimeBackup("));
});

test("ARCH-RUNTIME-03: rollback creates safety backup before replacing runtime", () => {
  const rollbackStart = manager.indexOf("export function rollbackProjectRuntime");
  const doctorStart = manager.indexOf("export function doctorProjectRuntime");
  const rollbackBody = manager.slice(rollbackStart, doctorStart);
  assert.ok(rollbackBody.indexOf("createRuntimeBackup(") >= 0);
  assert.ok(rollbackBody.indexOf("removeManagedRuntime(") > rollbackBody.indexOf("createRuntimeBackup("));
});

test("ARCH-RUNTIME-04: active execution is fail-closed while HUMAN_GATE remains repairable", () => {
  assert.match(manager, /"CI_WAIT"/);
  assert.match(manager, /"EXECUTING"/);
  assert.match(manager, /"DELEGATED"/);
  assert.match(manager, /QUIESCENT_STATES = new Set\(\["DONE", "BLOCKED", "HUMAN_GATE"\]\)/);
  assert.match(manager, /RUNTIME_NOT_QUIESCENT/);
});

test("ARCH-RUNTIME-05: managed runtime is content-addressed and symlinks are copied verbatim", () => {
  assert.match(manager, /manifestHash/);
  assert.match(manager, /buildRuntimeManifest/);
  assert.match(manager, /verbatimSymlinks: true/);
  assert.match(manager, /RUNTIME_INTEGRITY/);
});

test("ARCH-RUNTIME-06: update never imports source execution state", () => {
  assert.equal(manager.includes("copyPath(sourceRuntimeRoot, targetDir, \".agents/state"), false);
  assert.equal(manager.includes("copyPath(sourceRuntimeRoot, targetDir, \".agents/telemetry"), false);
  assert.equal(manager.includes("copyPath(sourceRuntimeRoot, targetDir, \".agents/dream-data"), false);
  assert.match(manager, /sanitizeCopiedRuntime/);
});
