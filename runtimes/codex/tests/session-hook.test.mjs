import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { prepareCodexSessionHandoff } from "../.codex/astra-orchestra/session-authority.mjs";
import { createImplementationHandoff } from "../.codex/astra-orchestra/routing-policy.mjs";

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
  cpSync(join(runtimeDir, "session-post-tool-hook.mjs"), join(root, ".codex", "astra-orchestra", "session-post-tool-hook.mjs"));
  cpSync(join(runtimeDir, "verification-guard.mjs"), join(root, ".codex", "astra-orchestra", "verification-guard.mjs"));
  cpSync(join(runtimeDir, "work-lease-authority.mjs"), join(root, ".codex", "astra-orchestra", "work-lease-authority.mjs"));
  cpSync(join(runtimeDir, "core"), join(root, ".codex", "astra-orchestra", "core"), { recursive: true });
  cpSync(join(runtimeDir, "provider"), join(root, ".codex", "astra-orchestra", "provider"), { recursive: true });
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  mkdirSync(join(root, ".codex", "orchestra-state"), { recursive: true });
  return root;
}

function hook(root, payload, { authorityMode = "session" } = {}) {
  return spawnSync(process.execPath, [join(root, ".codex", "astra-orchestra", "session-hook.mjs")], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ cwd: root, ...payload }),
    env: { ...process.env, ORCHESTRA_AUTHORITY_MODE: authorityMode },
  });
}

function jsonOut(result) {
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

test("SessionStart bootstrap plus PreToolUse enforce factual root identity in session rollback mode", () => {
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

test("dual mode fresh root advances Work Lease control without prepared handoff and fences former root", () => {
  const root = project();
  try {
    const first = hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "root-a" }, { authorityMode: "dual" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(jsonOut(first).hookSpecificOutput.additionalContext, /WORK LEASE AUTHORITY/);

    writeFileSync(join(root, ".codex", "orchestra-state", "active-state.json"), JSON.stringify({
      taskId: "task-1",
      state: "VERIFYING",
      candidateId: "candidate-7",
    }, null, 2) + "\n");

    const second = hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "root-b" }, { authorityMode: "dual" });
    assert.equal(second.status, 0, second.stderr);
    const context = jsonOut(second).hookSpecificOutput.additionalContext;
    assert.match(context, /WORK LEASE AUTHORITY/);
    assert.match(context, /generation=1/);
    assert.doesNotMatch(context, /HANDOFF REQUIRED/);

    const formerPrompt = hook(root, { hook_event_name: "UserPromptSubmit", session_id: "root-a", prompt: "keep working" }, { authorityMode: "dual" });
    assert.equal(formerPrompt.status, 0, formerPrompt.stderr);
    assert.equal(formerPrompt.stdout.trim(), ""); // Chat text remains usable; old generation has no tools.
    const forbiddenEdit = hook(root, { hook_event_name: "PreToolUse", session_id: "root-a", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } }, { authorityMode: "dual" });
    assert.equal(jsonOut(forbiddenEdit).hookSpecificOutput.permissionDecision, "deny");
    assert.match(jsonOut(forbiddenEdit).hookSpecificOutput.permissionDecisionReason, /STALE_WORK_LEASE/);

    const currentRead = hook(root, { hook_event_name: "PreToolUse", session_id: "root-b", tool_name: "Bash", tool_input: { command: "git status --short" } }, { authorityMode: "dual" });
    assert.equal(currentRead.status, 0, currentRead.stderr);
    assert.equal(currentRead.stdout.trim(), "");

    const persisted = readFileSync(join(root, ".orchestra", "state", "work-lease.json"), "utf8");
    assert.doesNotMatch(persisted, /root-a|root-b/);
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

test("fresh Codex root without valid handoff receives no current task capsule and cannot use tools in session mode", () => {
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

test("CI-first project policy blocks configured heavy commands for root and subagent calls", () => {
  const root = project();
  try {
    hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "root-a" });
    writeFileSync(join(root, ".codex", "orchestra-verification.json"), JSON.stringify({
      schema: "orchestra.codex-verification.v1",
      mode: "CI_FIRST",
      authoritativeGate: "Fast CI",
      localHeavyAttempts: 0,
      heavyLocalCommands: ["gradlew", "gradle"],
    }));
    const handoff = createImplementationHandoff({
      projectRoot: root,
      taskDomain: "CODE",
      requiredEvidence: [{ id: "ci", kind: "REMOTE_CI", class: "FAST_CI" }],
    });
    assert.equal(handoff.workerPacket.mandatory_core.scope.verification_policy.mode, "CI_FIRST");
    assert.throws(() => createImplementationHandoff({
      projectRoot: root,
      taskDomain: "CODE",
      verificationPolicy: { mode: "LOCAL_FOCUSED" },
    }), /PROJECT_VERIFICATION_POLICY_MISMATCH/);
    for (const command of ["./gradlew test", "timeout 120 ./gradlew test", "bash -lc './gradlew test'"]) {
      const denied = hook(root, { hook_event_name: "PreToolUse", session_id: "root-a", agent_id: "worker-a", tool_name: "Bash", tool_input: { command } });
      assert.equal(jsonOut(denied)?.hookSpecificOutput.permissionDecision, "deny", command);
    }
    const search = hook(root, { hook_event_name: "PreToolUse", session_id: "root-a", tool_name: "Bash", tool_input: { command: "rg -n gradlew docs" } });
    assert.equal(search.stdout.trim(), "");
    const edit = hook(root, { hook_event_name: "PreToolUse", session_id: "root-a", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } });
    assert.equal(edit.stdout.trim(), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid project verification policy blocks shell execution", () => {
  const root = project();
  try {
    hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "root-a" });
    writeFileSync(join(root, ".codex", "orchestra-verification.json"), "{invalid");
    const result = hook(root, { hook_event_name: "PreToolUse", session_id: "root-a", tool_name: "Bash", tool_input: { command: "echo ok" } });
    assert.equal(jsonOut(result)?.hookSpecificOutput.permissionDecisionReason, "VERIFICATION_CONFIG_UNREADABLE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("blocked new root can submit a prompt but cannot edit while another session holds the writer", () => {
  const root = project();
  try {
    const first = hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "writer-a" }, { authorityMode: "lease" });
    assert.equal(first.status, 0, first.stderr);
    const edit = hook(root, { hook_event_name: "PreToolUse", session_id: "writer-a", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } }, { authorityMode: "lease" });
    assert.equal(edit.status, 0);
    assert.equal(edit.stdout.trim(), "");

    const newcomer = hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "new-b" }, { authorityMode: "lease" });
    assert.match(jsonOut(newcomer).hookSpecificOutput.additionalContext, /WRITE_LEASE_ACTIVE/);

    const prompt = hook(root, { hook_event_name: "UserPromptSubmit", session_id: "new-b", prompt: "Diagnose why another chat is blocking this worktree" }, { authorityMode: "lease" });
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.equal(prompt.stdout.trim(), "");
    const forbidden = hook(root, { hook_event_name: "PreToolUse", session_id: "new-b", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } }, { authorityMode: "lease" });
    assert.equal(jsonOut(forbidden).hookSpecificOutput.permissionDecision, "deny");
    assert.match(jsonOut(forbidden).hookSpecificOutput.permissionDecisionReason, /LEASE_BINDING_MISSING|WRITE_LEASE_ACTIVE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex 0.159 native hook wire contains no unknown top-level fields", () => {
  const root = project();
  try {
    const started = hook(root, { hook_event_name: "SessionStart", source: "startup", session_id: "root-a" }, { authorityMode: "lease" });
    assert.equal(started.status, 0);
    assert.deepEqual(Object.keys(jsonOut(started)), ["hookSpecificOutput"]);
    assert.deepEqual(Object.keys(jsonOut(started).hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);

    const denied = hook(root, { hook_event_name: "PreToolUse", session_id: "root-b", tool_name: "apply_patch", tool_input: {} }, { authorityMode: "lease" });
    assert.equal(denied.status, 0, "A semantic deny must exit successfully to be honored by Codex");
    assert.deepEqual(Object.keys(jsonOut(denied)), ["hookSpecificOutput"]);
    assert.deepEqual(Object.keys(jsonOut(denied).hookSpecificOutput).sort(), ["hookEventName", "permissionDecision", "permissionDecisionReason"]);
    assert.equal(jsonOut(denied).hookSpecificOutput.permissionDecision, "deny");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("real issue 155 native Luna handoff is allowed for root CONTROL but unknown/child/unregistered roles stay denied", () => {
  const root = project();
  try {
    const start = hook(root, { hook_event_name: "SessionStart", session_id: "root-155", source: "startup" }, { authorityMode: "lease" });
    assert.equal(start.status, 0, start.stderr);
    const input = { agent_type: "luna-max", message: "Implement bounded Phase 0 regressions", fork_context: false };
    const spawn = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", tool_name: "collaborationspawn_agent", tool_call_id: "spawn-luna-1", tool_input: input }, { authorityMode: "lease" });
    assert.equal(spawn.status, 0, spawn.stderr);
    assert.equal(spawn.stdout.trim(), "", "root delegation does not silently mutate or require workspace edit");
    const lease = JSON.parse(readFileSync(join(root, ".orchestra", "state", "work-lease.json"), "utf8"));
    assert.deepEqual(lease.capabilities, ["CONTROL"]);

    const wait = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", tool_name: "collaborationwait_agent", tool_input: { target: "worker-1" } }, { authorityMode: "lease" });
    assert.equal(wait.status, 0, wait.stderr);
    assert.equal(wait.stdout.trim(), "");

    const nested = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", agent_id: "luna-child", tool_name: "collaborationspawn_agent", tool_input: input }, { authorityMode: "lease" });
    assert.equal(jsonOut(nested).hookSpecificOutput.permissionDecision, "deny");
    assert.match(jsonOut(nested).hookSpecificOutput.permissionDecisionReason, /CHILD|DELEGATION/);
    const missingRole = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", tool_name: "collaborationspawn_agent", tool_input: {} }, { authorityMode: "lease" });
    assert.equal(jsonOut(missingRole).hookSpecificOutput.permissionDecision, "deny");
    const unknownRole = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", tool_name: "collaborationspawn_agent", tool_input: { agent_type: "unregistered-agent" } }, { authorityMode: "lease" });
    assert.equal(jsonOut(unknownRole).hookSpecificOutput.permissionDecision, "deny");
    const unknown = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", tool_name: "collaborationfuture_unknown", tool_input: {} }, { authorityMode: "lease" });
    assert.match(jsonOut(unknown).hookSpecificOutput.permissionDecisionReason, /UNKNOWN_OPERATION/);

    const stale = hook(root, { hook_event_name: "PreToolUse", session_id: "wrong-generation", tool_name: "collaborationspawn_agent", tool_input: input }, { authorityMode: "lease" });
    assert.equal(jsonOut(stale).hookSpecificOutput.permissionDecision, "deny");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("field #155 native root web and user clarification are CONTROL-only; child access and unknown tools denied", () => {
  const root = project();
  try {
    assert.equal(hook(root, { hook_event_name: "SessionStart", session_id: "root-155", source: "startup" }, { authorityMode: "lease" }).status, 0);
    for (const tool_name of ["webrun", "request_user_input_async"]) {
      const allowed = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", tool_name, tool_input: { query: "MangaDex API docs" } }, { authorityMode: "lease" });
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.equal(allowed.stdout.trim(), "", tool_name);
      const child = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", agent_id: "worker-2", tool_name, tool_input: { query: "scope leak" } }, { authorityMode: "lease" });
      assert.equal(jsonOut(child).hookSpecificOutput.permissionDecision, "deny", tool_name);
    }
    const unknown = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", tool_name: "webrun_custom", tool_input: {} }, { authorityMode: "lease" });
    assert.match(jsonOut(unknown).hookSpecificOutput.permissionDecisionReason, /UNKNOWN_OPERATION/);
    const lease = JSON.parse(readFileSync(join(root, ".orchestra", "state", "work-lease.json"), "utf8"));
    assert.deepEqual(lease.capabilities, ["CONTROL"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("field #155 agent communication is distinct from recursive spawn and remains scope bounded", () => {
  const root = project();
  try {
    hook(root, { hook_event_name: "SessionStart", session_id: "root-155", source: "startup" }, { authorityMode: "lease" });
    const rootMessage = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", tool_name: "send_message", tool_input: { target: "worker-2", message: "Continue bounded tests" } }, { authorityMode: "lease" });
    assert.equal(rootMessage.stdout.trim(), "");
    const childToParent = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", agent_id: "luna-2", tool_name: "send_message", tool_input: { target: "parent", message: "Test results ready" } }, { authorityMode: "lease" });
    assert.equal(childToParent.stdout.trim(), "");
    const childPeer = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", agent_id: "luna-2", tool_name: "send_message", tool_input: { target: "worker-3", message: "Run tests" } }, { authorityMode: "lease" });
    assert.equal(jsonOut(childPeer).hookSpecificOutput.permissionDecision, "deny");
    const childSpawn = hook(root, { hook_event_name: "PreToolUse", session_id: "root-155", agent_id: "luna-2", tool_name: "collaborationspawn_agent", tool_input: { agent_type: "luna-max" } }, { authorityMode: "lease" });
    assert.equal(jsonOut(childSpawn).hookSpecificOutput.permissionDecision, "deny");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("native PostToolUse handler releases factual root writer only after matching terminal callback", () => {
  const root = project();
  try {
    const mode = { authorityMode: "lease" };
    hook(root, { hook_event_name: "SessionStart", session_id: "root-155", source: "startup" }, mode);
    const edit = hook(root, {
      hook_event_name: "PreToolUse", session_id: "root-155",
      tool_name: "apply_patch", tool_call_id: "real-edit-1",
      tool_input: { command: "*** Begin Patch" },
    }, mode);
    assert.equal(edit.status, 0, edit.stderr);
    assert.equal(edit.stdout.trim(), "");
    const stateFile = join(root, ".orchestra", "state", "work-lease.json");
    let lease = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(lease.capabilities, ["CONTROL", "WORKSPACE_EDIT"]);

    function post(sessionId) {
      return spawnSync(process.execPath, [join(root, ".codex", "astra-orchestra", "session-post-tool-hook.mjs")], {
        cwd: root, encoding: "utf8", env: { ...process.env, ORCHESTRA_AUTHORITY_MODE: "lease" },
        input: JSON.stringify({ cwd: root, hook_event_name: "PostToolUse", session_id: sessionId, tool_name: "apply_patch", tool_call_id: "real-edit-1" }),
      });
    }
    const foreign = post("foreign");
    assert.equal(foreign.status, 0);
    lease = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.ok(lease.capabilities.includes("WORKSPACE_EDIT"), "foreign terminal callback cannot release writer");

    const finished = post("root-155");
    assert.equal(finished.status, 0);
    assert.equal(finished.stderr.trim(), "");
    lease = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(lease.capabilities, ["CONTROL"]);
    assert.equal(lease.state, "CONTROL");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
