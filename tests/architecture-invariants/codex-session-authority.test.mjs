import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_SESSION_AUTHORITY_STATUSES,
  CODEX_SESSION_HANDOFF_MODE,
} from "../../runtimes/codex/.codex/astra-orchestra/session-authority.mjs";
import {
  CODEX_MANAGED_RUNTIME_PATHS,
  CODEX_PRESERVED_PROJECT_PATHS,
} from "../../runtimes/codex/.codex/astra-orchestra/codex-runtime-manager.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const authoritySource = read("runtimes/codex/.codex/astra-orchestra/session-authority.mjs");
const hookSource = read("runtimes/codex/.codex/astra-orchestra/session-hook.mjs");
const hooks = JSON.parse(read("runtimes/codex/.codex/hooks.json"));

test("ARCH-O01: Codex uses provider-factual session_id and never invents a conversation identity", () => {
  assert.match(hookSource, /payload\.session_id/);
  assert.match(authoritySource, /main_session_id/);
  assert.doesNotMatch(authoritySource, /mainConversationId|conversationId/);
  assert.doesNotMatch(hookSource, /mainConversationId|conversationId/);
});

test("ARCH-O02: session hooks enforce root authority before prompts and supported local tools", () => {
  assert.ok(Array.isArray(hooks.hooks.SessionStart));
  assert.ok(Array.isArray(hooks.hooks.PreToolUse));
  assert.ok(Array.isArray(hooks.hooks.UserPromptSubmit));
  assert.equal(hooks.hooks.PreToolUse[0].matcher, ".*");
  assert.match(hookSource, /permissionDecision:\s*"deny"/);
  assert.match(hookSource, /decision:\s*"block"/);
});

test("ARCH-O03: Codex transfer is single-writer and fail-closed while transaction is partial", () => {
  assert.deepEqual(CODEX_SESSION_AUTHORITY_STATUSES, {
    ACTIVE: "ACTIVE",
    TRANSFERRING: "TRANSFERRING",
  });
  assert.equal(CODEX_SESSION_HANDOFF_MODE, "MILESTONE_BOUNDARY");
  assert.match(authoritySource, /openSync\(p\.claimLock,\s*"wx"/);
  assert.match(authoritySource, /CODEX_SESSION_AUTHORITY_TRANSFERRING/);
  assert.match(authoritySource, /resumeCodexSessionTransfer/);
});

test("ARCH-O04: boundary handoff does not migrate transcript, prompt, reasoning, scope, or evidence", () => {
  assert.doesNotMatch(hookSource, /createContinuationCapsule|formatContinuationCapsule|trust-boundary/);
  assert.doesNotMatch(hookSource, /readFileSync\([^\n]*transcript/i);
  assert.match(authoritySource, /FRESH_MILESTONE_NO_PREVIOUS_SCOPE_EVIDENCE_OR_TRANSCRIPT/);
  assert.match(authoritySource, /state:\s*"INTAKE"/);
  assert.match(authoritySource, /rmSync\(p\.activeContract/);
});

test("ARCH-O05: hooks are runtime-owned while authority and handoff records remain project-owned", () => {
  assert.deepEqual(CODEX_MANAGED_RUNTIME_PATHS, [
    ".codex/config.toml",
    ".codex/hooks.json",
    ".codex/agents",
    ".codex/astra-orchestra",
  ]);
  assert.ok(CODEX_PRESERVED_PROJECT_PATHS.includes(".codex/orchestra-state"));
  assert.equal(CODEX_MANAGED_RUNTIME_PATHS.includes(".codex/orchestra-state"), false);
});

test("ARCH-O06: Codex handoff implementation remains provider-isolated", () => {
  for (const source of [authoritySource, hookSource]) {
    assert.doesNotMatch(source, /(?:from|import|require)\s+["'][^"']*(?:runtimes[\\/]antigravity|\.agents[\\/])/i);
    assert.doesNotMatch(source, /gemini-|claude-|flash-orchestrator|ORCHESTRATOR_HANDOFF/);
  }
});
