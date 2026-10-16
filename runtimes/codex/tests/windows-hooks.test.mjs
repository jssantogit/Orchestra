import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const hooksPath = resolve(repoRoot, "runtimes/codex/.codex/hooks.json");
const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));

function allCommandWindows() {
  const values = [];
  for (const [event, groups] of Object.entries(hooks.hooks || {})) {
    for (const group of groups || []) {
      for (const hook of group.hooks || []) {
        if (hook.type === "command" && hook.commandWindows) {
          values.push({ event, commandWindows: hook.commandWindows });
        }
      }
    }
  }
  return values;
}

test("Codex commandWindows hooks are native PowerShell bodies, not nested PowerShell launchers", () => {
  const commands = allCommandWindows();
  assert.ok(commands.length >= 4);

  for (const { event, commandWindows } of commands) {
    assert.doesNotMatch(commandWindows, /^\s*powershell(?:\.exe)?\b/i, `${event} must not nest powershell inside commandWindows`);
    assert.match(commandWindows, /git rev-parse --show-toplevel/);
    assert.match(commandWindows, /\.Trim\(\)/, `${event} must trim git output before Join-Path`);
    assert.match(commandWindows, /Join-Path \$root '\.codex\/astra-orchestra\/session(?:-post-tool)?-hook\.mjs'/);
  }
});

test("Codex Desktop-style outer PowerShell executes SessionStart commandWindows successfully", { skip: process.platform !== "win32" }, () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "orch-codex-windows-hook-"));
  try {
    execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
    cpSync(resolve(repoRoot, "runtimes/codex/.codex"), join(projectRoot, ".codex"), { recursive: true });

    const installedHooks = JSON.parse(readFileSync(join(projectRoot, ".codex", "hooks.json"), "utf8"));
    const commandWindows = installedHooks.hooks.SessionStart[0].hooks[0].commandWindows;
    const payload = {
      hook_event_name: "SessionStart",
      session_id: "windows-native-hook-test",
      source: "startup",
      cwd: projectRoot,
    };

    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", commandWindows],
      {
        cwd: projectRoot,
        input: JSON.stringify(payload),
        encoding: "utf8",
        windowsHide: true,
      },
    );

    assert.equal(
      result.status,
      0,
      `commandWindows failed under the Codex Desktop-style outer PowerShell.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.hookSpecificOutput?.hookEventName, "SessionStart");
    assert.equal(output.continue, true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
