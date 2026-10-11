import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CODEX_RUNTIME,
  installCodexProjectRuntime,
  updateCodexProjectRuntime,
  rollbackCodexProjectRuntime,
} from "../../providers/codex/project-runtime-manager.mjs";
import {
  ANTIGRAVITY_RUNTIME,
  installAntigravityProjectRuntime,
  updateAntigravityProjectRuntime,
  rollbackAntigravityProjectRuntime,
} from "../../providers/antigravity/project-runtime-manager.mjs";

const read = (relativePath) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("provider project managers are thin canonical wrappers over the shared manager", async () => {
  assert.equal(CODEX_RUNTIME, "codex");
  assert.equal(ANTIGRAVITY_RUNTIME, "antigravity");
  for (const fn of [
    installCodexProjectRuntime,
    updateCodexProjectRuntime,
    rollbackCodexProjectRuntime,
    installAntigravityProjectRuntime,
    updateAntigravityProjectRuntime,
    rollbackAntigravityProjectRuntime,
  ]) assert.equal(typeof fn, "function");

  for (const path of [
    "providers/codex/project-runtime-manager.mjs",
    "providers/antigravity/project-runtime-manager.mjs",
  ]) {
    const source = await read(path);
    assert.match(source, /runtime\/project-runtime-manager\.mjs/);
    assert.match(source, /runtime\/manifest-loader\.mjs/);
    assert.doesNotMatch(source, /runtimes\/(codex|antigravity)/);
    assert.doesNotMatch(source, /node:fs/);
  }
});

test("source installers route through canonical provider wrappers, not runtime-local managers", async () => {
  const codex = await read("scripts/install-codex.mjs");
  const antigravity = await read("scripts/install-antigravity.mjs");

  assert.match(codex, /providers\/codex\/project-runtime-manager\.mjs/);
  assert.match(antigravity, /providers\/antigravity\/project-runtime-manager\.mjs/);
  assert.doesNotMatch(codex, /runtimes\/codex\/.*runtime-manager/);
  assert.doesNotMatch(antigravity, /runtimes\/antigravity\/.*runtime-manager/);
});
