import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { prepareCodexSessionHandoff } from "../.codex/astra-orchestra/session-authority.mjs";

const runtimeDir = resolve(fileURLToPath(new URL("../.codex/astra-orchestra/", import.meta.url)));

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "orch-codex-hook-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "product.txt"), "v1\n");
  mkdirSync(join(root, ".codex", "astra-orchestra"), { recursive: true });
  cpSync(join(runtimeDir, "session-authority.mjs"), join(root, ".codex", "astra-orchestra", "session-authority.mjs"));
  cpSync(join(runtimeDir, "session-hook.mjs"), join(root, ".codex", "astra-orchestra", "session-hook.mjs"));
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  mkdirSync(join(root, ".codex", "orchestra-state"), { recursive: true });
  return root;
}

function hook(root, payload) {
  return spawnSync(process.execPath, [join(root, ".codex", "astra-orchestra", "session-hook.mjs")], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ cwd: root, ...payload }),
  });
}

function jsonOut(result) {
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

test("SessionStart bootstrap plus PreToolUse enforce factual root identity", () => {
  const root = project();
  try {
    const start = hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "root-a" });
    assert.equal(start.status, 0, start.stderr);
    assert.match(jsonOut(start).hookSpecificOutput.additionalContext, /AUTHORITATIVE/);

    const oldTool = hook(root, { hook_event_name: "PreToolUse", session_id: "root-a", tool_name: "Bash", tool_input: { command: "git status" } });
    assert.equal(oldTool.status, 0);
    assert.equal(oldTool.stdout.trim(), "");

    const foreign = hook(root, { hook_event_name: "PreToolUse", session_id: "root-b", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } });
    assert.equal(foreign.status, 0);
    assert.equal(jsonOut(foreign).hookSpecificOutput.permissionDecision, "deny");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh Codex root claims an armed boundary automatically and former root loses tool authority", () => {
  const root = project();
  try {
    hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "root-a" });
    writeFileSync(join(root, ".codex", "orchestra-state", "active-state.json"), JSON.stringify({ taskId: "m1", state: "DONE", evidenceLedger: [{ id: "old" }] }, null, 2));
    prepareCodexSessionHandoff(root, { reason: "new milestone" });

    const next = hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "root-b" });
    assert.equal(next.status, 0, next.stderr);
    assert.match(jsonOut(next).hookSpecificOutput.additionalContext, /HANDOFF CLAIMED/);

    const formerPrompt = hook(root, { hook_event_name: "UserPromptSubmit", session_id: "root-a", prompt: "keep working" });
    assert.equal(jsonOut(formerPrompt).decision, "block");
    const former = hook(root, { hook_event_name: "PreToolUse", session_id: "root-a", tool_name: "Bash", tool_input: { command: "echo nope" } });
    assert.equal(jsonOut(former).hookSpecificOutput.permissionDecision, "deny");

    const currentPrompt = hook(root, { hook_event_name: "UserPromptSubmit", session_id: "root-b", prompt: "continue" });
    assert.equal(currentPrompt.stdout.trim(), "");
    const current = hook(root, { hook_event_name: "PreToolUse", session_id: "root-b", tool_name: "Bash", tool_input: { command: "echo ok" } });
    assert.equal(current.stdout.trim(), "");
    const state = JSON.parse(readFileSync(join(root, ".codex", "orchestra-state", "active-state.json"), "utf8"));
    assert.equal(state.state, "INTAKE");
    assert.equal(state.evidenceLedger, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh Codex root without valid lease receives no current task capsule and cannot use tools", () => {
  const root = project();
  try {
    hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "root-a" });
    writeFileSync(join(root, ".codex", "orchestra-state", "active-state.json"), JSON.stringify({ taskId: "secret-task", state: "DONE", scopeContract: { allowedPaths: ["secret/**"] }, evidenceLedger: [{ id: "secret-evidence" }] }, null, 2));
    const next = hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "root-b" });
    const out = jsonOut(next).hookSpecificOutput.additionalContext;
    assert.match(out, /HANDOFF REQUIRED/);
    assert.doesNotMatch(out, /secret-task|secret\/\*\*|secret-evidence/);
    const tool = hook(root, { hook_event_name: "PreToolUse", session_id: "root-b", tool_name: "Bash", tool_input: { command: "cat secret" } });
    assert.equal(jsonOut(tool).hookSpecificOutput.permissionDecision, "deny");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
