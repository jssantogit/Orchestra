import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const orchestraRoot = new URL("../../", import.meta.url).pathname;
const installCodexScript = join(orchestraRoot, "scripts/install-codex.sh");
const installAgyScript = join(orchestraRoot, "scripts/install-antigravity.sh");

test("installer: installs Codex runtime cleanly into empty project", () => {
  const tempProject = mkdtempSync(join(tmpdir(), "orch-test-codex-"));
  try {
    const output = execFileSync(installCodexScript, [tempProject], { encoding: "utf8" });
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
    const output = execFileSync(installAgyScript, [tempProject], { encoding: "utf8" });
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
    execFileSync(installCodexScript, [tempProject], { encoding: "utf8" });

    // Try second time -> must fail with code 2
    assert.throws(() => {
      execFileSync(installCodexScript, [tempProject], { stdio: "pipe" });
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
    execFileSync(installAgyScript, [tempProject], { encoding: "utf8" });

    // Try second time -> must fail with code 2
    assert.throws(() => {
      execFileSync(installAgyScript, [tempProject], { stdio: "pipe" });
    }, (err) => {
      return err.status === 2;
    });
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});
