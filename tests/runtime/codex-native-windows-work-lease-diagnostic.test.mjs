import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { enterCodexWorkLease } from "../../runtimes/codex/.codex/astra-orchestra/work-lease-authority.mjs";

const diagnosticModule = "../../runtimes/codex/.codex/astra-orchestra/work-lease-authority.mjs";
const diagnosticCli = fileURLToPath(new URL("../../runtimes/codex/.codex/astra-orchestra/work-lease-diagnostic-cli.mjs", import.meta.url));
const hooksPath = fileURLToPath(new URL("../../runtimes/codex/.codex/hooks.json", import.meta.url));
const runtimeRoot = fileURLToPath(new URL("../../runtimes/codex/.codex/astra-orchestra/", import.meta.url));

function project() {
  const root = mkdtempSync(join(tmpdir(), "orch-codex-native-diagnostic-"));
  mkdirSync(join(root, ".codex", "orchestra-state"), { recursive: true });
  return root;
}

function windowsHookProject() {
  const root = mkdtempSync(join(tmpdir(), "orch-codex-windows-hook-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, ".codex"), { recursive: true });
  cpSync(runtimeRoot, join(root, ".codex", "astra-orchestra"), { recursive: true });
  return root;
}

function writeActiveState(root, value = {}) {
  writeFileSync(join(root, ".codex", "orchestra-state", "active-state.json"), JSON.stringify(value, null, 2) + "\n");
}

function hookEntries() {
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  const groups = [
    ...hooks.hooks.SessionStart,
    ...hooks.hooks.UserPromptSubmit,
    ...hooks.hooks.PreToolUse,
    ...hooks.hooks.PostToolUse,
  ];
  return {
    hooks,
    entries: groups.flatMap((group) => group.hooks || []),
  };
}

test("Codex commandWindows hooks are native PowerShell bodies without nested powershell launchers", () => {
  const { entries } = hookEntries();

  assert.equal(entries.length, 4);
  for (const entry of entries) {
    assert.doesNotMatch(entry.commandWindows, /^powershell(?:\.exe)?\s/i);
    assert.match(entry.commandWindows, /git rev-parse --show-toplevel\)\.Trim\(\)/);
    assert.match(entry.commandWindows, /Join-Path \$root '\.codex\/astra-orchestra\/session-(?:post-tool-)?hook\.mjs'/);
  }
});

test("Codex Desktop-style outer PowerShell executes commandWindows without nested expansion", { skip: process.platform !== "win32" }, () => {
  const root = windowsHookProject();
  try {
    const { hooks } = hookEntries();
    const command = hooks.hooks.SessionStart[0].hooks[0].commandWindows;
    const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({
        cwd: root,
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "windows-native-root",
      }),
      env: { ...process.env, ORCHESTRA_AUTHORITY_MODE: "lease" },
    });

    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /WORK LEASE AUTHORITY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only Work Lease diagnostic distinguishes missing lease without creating authority state", async () => {
  const root = project();
  try {
    const { diagnoseCodexWorkLease } = await import(diagnosticModule);
    assert.equal(typeof diagnoseCodexWorkLease, "function");

    const result = diagnoseCodexWorkLease(root);
    assert.equal(result.ok, true);
    assert.equal(result.lease.status, "MISSING");
    assert.equal(result.lease.reason, "WORK_LEASE_NOT_INITIALIZED");
    assert.equal(result.bindings.status, "MISSING");
    assert.equal(result.authority.status, "UNKNOWN");
    assert.equal(result.authority.reason, "CODEX_SESSION_ID_REQUIRED");
    assert.equal(existsSync(join(root, ".orchestra", "state", "work-lease.json")), false);
    assert.equal(existsSync(join(root, ".codex", "orchestra-state", "work-lease-session-bindings.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only Work Lease diagnostic preserves invalid lease reason", async () => {
  const root = project();
  try {
    mkdirSync(join(root, ".orchestra", "state"), { recursive: true });
    writeFileSync(join(root, ".orchestra", "state", "work-lease.json"), "{not-json\n");
    const { diagnoseCodexWorkLease } = await import(diagnosticModule);

    const result = diagnoseCodexWorkLease(root);
    assert.equal(result.ok, true);
    assert.equal(result.lease.status, "INVALID");
    assert.equal(result.lease.reason, "LEASE_PARSE_INVALID");
    assert.equal(result.authority.status, "UNKNOWN");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only Work Lease diagnostic reports allowed and stale session authority", async () => {
  const root = project();
  try {
    writeActiveState(root, { taskId: "task-1", state: "VERIFYING" });
    const first = enterCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(first.authoritative, true);

    const { diagnoseCodexWorkLease } = await import(diagnosticModule);
    const allowed = diagnoseCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(allowed.lease.status, "VALID");
    assert.equal(allowed.bindings.status, "BOUND");
    assert.equal(allowed.authority.status, "ALLOWED");
    assert.equal(allowed.authority.reason, null);

    const second = enterCodexWorkLease(root, { sessionId: "root-b", mode: "lease" });
    assert.equal(second.authoritative, true);
    const stale = diagnoseCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(stale.authority.status, "DENIED");
    assert.equal(stale.authority.reason, "STALE_WORK_LEASE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only Work Lease diagnostic exposes invalid bindings without mutating them", async () => {
  const root = project();
  try {
    writeActiveState(root, { taskId: "task-1", state: "VERIFYING" });
    const first = enterCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(first.authoritative, true);
    const bindingsPath = join(root, ".codex", "orchestra-state", "work-lease-session-bindings.json");
    writeFileSync(bindingsPath, "{bad-json\n");

    const { diagnoseCodexWorkLease } = await import(diagnosticModule);
    const result = diagnoseCodexWorkLease(root, { sessionId: "root-a", mode: "lease" });
    assert.equal(result.bindings.status, "INVALID");
    assert.equal(result.bindings.reason, "LEASE_BINDINGS_INVALID");
    assert.equal(result.authority.status, "DENIED");
    assert.equal(result.authority.reason, "LEASE_BINDINGS_INVALID");
    assert.equal(readFileSync(bindingsPath, "utf8"), "{bad-json\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official Work Lease diagnostic CLI returns semantic missing state with exit zero", () => {
  const root = project();
  try {
    const stdout = execFileSync(process.execPath, [diagnosticCli, "--repo-root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.lease.status, "MISSING");
    assert.equal(result.lease.reason, "WORK_LEASE_NOT_INITIALIZED");
    assert.equal(result.authority.status, "UNKNOWN");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
