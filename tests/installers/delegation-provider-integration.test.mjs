import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const codexCli = join(repoRoot, "scripts", "orchestra-codex-project.mjs");
const antigravityCli = join(repoRoot, "scripts", "orchestra-project.mjs");

function runJson(script, args) {
  return JSON.parse(execFileSync(process.execPath, [script, ...args, "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  }));
}

function initProject() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-provider-install-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test("Codex project install ensures provider and shared delegation runtimes with explicit status", (t) => {
  const target = initProject();
  t.after(() => rmSync(target, { recursive: true, force: true }));

  const result = runJson(codexCli, ["install", target]);
  assert.equal(result.providerRuntime.runtime, "codex");
  assert.equal(result.providerRuntime.operation, "install");
  assert.equal(result.delegationRuntime.runtime, "delegation");
  assert.equal(result.delegationRuntime.operation, "install");
  assert.equal(existsSync(join(target, ".codex", "config.toml")), true);
  assert.equal(existsSync(join(target, ".orchestra", "runtime", "delegation", "runtime", "delegation", "cli.mjs")), true);
  assert.equal(existsSync(join(target, ".orchestra", "state", "runtimes", "delegation.json")), true);
});

test("second provider install reuses shared delegation runtime without ownership collision", (t) => {
  const target = initProject();
  t.after(() => rmSync(target, { recursive: true, force: true }));

  const codex = runJson(codexCli, ["install", target]);
  assert.equal(codex.delegationRuntime.operation, "install");

  const antigravity = runJson(antigravityCli, ["install", target]);
  assert.equal(antigravity.providerRuntime.runtime, "antigravity");
  assert.equal(antigravity.providerRuntime.operation, "install");
  assert.equal(antigravity.delegationRuntime.runtime, "delegation");
  assert.equal(antigravity.delegationRuntime.operation, "noop");
  assert.equal(antigravity.delegationRuntime.changed, false);
  assert.equal(existsSync(join(target, ".codex", "config.toml")), true);
  assert.equal(existsSync(join(target, ".agents", "hooks.json")), true);
});

test("provider dry-run reports shared delegation operation without mutating the project", (t) => {
  const target = initProject();
  t.after(() => rmSync(target, { recursive: true, force: true }));

  const result = runJson(codexCli, ["install", target, "--dry-run"]);
  assert.equal(result.providerRuntime.dryRun, true);
  assert.equal(result.delegationRuntime.dryRun, true);
  assert.equal(result.delegationRuntime.operation, "install");
  assert.equal(existsSync(join(target, ".codex")), false);
  assert.equal(existsSync(join(target, ".orchestra", "runtime", "delegation")), false);
});
