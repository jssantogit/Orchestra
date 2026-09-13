import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const orchestraRoot = fileURLToPath(new URL("../../", import.meta.url));
const installCodexScript = join(orchestraRoot, "scripts/install-codex.mjs");
const installAgyScript = join(orchestraRoot, "scripts/install-antigravity.mjs");

function runInstaller(script, args, options = {}) {
  return execFileSync(process.execPath, [script, ...args], options);
}

test("installer: installs Codex runtime cleanly into empty project", () => {
  const tempProject = mkdtempSync(join(tmpdir(), "orch-test-codex-"));
  try {
    const output = runInstaller(installCodexScript, [tempProject], { encoding: "utf8" });
    assert(output.includes("successfully installed"));
    assert.equal(existsSync(join(tempProject, ".codex/config.toml")), true);
    assert.equal(existsSync(join(tempProject, ".codex/astra-orchestra/INSTRUCTIONS.md")), true);
    assert.equal(existsSync(join(tempProject, ".codex/agents/luna-high.toml")), true);
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});

test("installer: installs Antigravity runtime cleanly into empty project without state", () => {
  const tempProject = mkdtempSync(join(tmpdir(), "orch-test-agy-"));
  try {
    const output = runInstaller(installAgyScript, [tempProject], { encoding: "utf8" });
    assert(output.includes("successfully installed"));
    assert.equal(existsSync(join(tempProject, ".agents/hooks.json")), true);
    assert.equal(existsSync(join(tempProject, ".agents/agents/flash-orchestrator.md")), true);
    assert.equal(existsSync(join(tempProject, ".agents/hooks/pre-tool-enforce.mjs")), true);
    assert.equal(existsSync(join(tempProject, ".agents/skills/orchestra/routing-policy.mjs")), true);
    // Verify no state or telemetry was copied
    assert.equal(existsSync(join(tempProject, ".agents/state/active-state.json")), false);
    assert.equal(existsSync(join(tempProject, ".agents/telemetry/events.jsonl")), false);
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});

test("installer: aborts on conflict without destructive overwrite (Codex)", () => {
  const tempProject = mkdtempSync(join(tmpdir(), "orch-test-conflict-"));
  try {
    // Install first time
    runInstaller(installCodexScript, [tempProject], { encoding: "utf8" });

    // Try second time -> must fail with code 2
    assert.throws(() => {
      runInstaller(installCodexScript, [tempProject], { stdio: "pipe" });
    }, (err) => {
      return err.status === 2;
    });
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});

test("installer: aborts on conflict without destructive overwrite (Antigravity)", () => {
  const tempProject = mkdtempSync(join(tmpdir(), "orch-test-conflict-"));
  try {
    // Install first time
    runInstaller(installAgyScript, [tempProject], { encoding: "utf8" });

    // Try second time -> must fail with code 2
    assert.throws(() => {
      runInstaller(installAgyScript, [tempProject], { stdio: "pipe" });
    }, (err) => {
      return err.status === 2;
    });
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});
