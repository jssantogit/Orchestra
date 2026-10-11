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
const leaseSource = read("runtimes/codex/.codex/astra-orchestra/work-lease-authority.mjs");
const hookSource = read("runtimes/codex/.codex/astra-orchestra/session-hook.mjs");
const hooks = JSON.parse(read("runtimes/codex/.codex/hooks.json"));

test("ARCH-O01: Codex uses provider-factual session_id as provenance and never invents conversation identity", () => {
  assert.match(hookSource, /payload\.session_id/);
  assert.match(authoritySource, /main_session_id/);
  assert.match(leaseSource, /sessionIdHash/);
  assert.doesNotMatch(authoritySource, /mainConversationId|conversationId/);
  assert.doesNotMatch(hookSource, /mainConversationId|conversationId/);
});

test("ARCH-O02: session hooks choose session rollback or generation-fenced Work Lease authority before prompts and tools", () => {
  assert.ok(Array.isArray(hooks.hooks.SessionStart));
  assert.ok(Array.isArray(hooks.hooks.PreToolUse));
  assert.ok(Array.isArray(hooks.hooks.UserPromptSubmit));
  assert.equal(hooks.hooks.PreToolUse[0].matcher, ".*");
  assert.match(hookSource, /resolveCodexAuthorityMode/);
  assert.match(hookSource, /authorizeCodexLeaseCapability/);
  assert.match(hookSource, /permissionDecision:\s*"deny"/);
  assert.match(hookSource, /decision:\s*"block"/);
  assert.match(leaseSource, /return "dual"/);
  assert.match(leaseSource, /STALE_WORK_LEASE/);
});

test("ARCH-O03: legacy session transfer remains single-writer fail-closed recovery in session rollback mode", () => {
  assert.deepEqual(CODEX_SESSION_AUTHORITY_STATUSES, {
    ACTIVE: "ACTIVE",
    TRANSFERRING: "TRANSFERRING",
  });
  assert.equal(CODEX_SESSION_HANDOFF_MODE, "MILESTONE_BOUNDARY");
  assert.match(authoritySource, /openSync\(p\.claimLock,\s*"wx"/);
  assert.match(authoritySource, /CODEX_SESSION_AUTHORITY_TRANSFERRING/);
  assert.match(authoritySource, /resumeCodexSessionTransfer/);
  assert.match(hookSource, /mode === "session"/);
  assert.match(hookSource, /handleLegacySessionStart/);
});

test("ARCH-O04: recovery boundary handoff does not migrate transcript, prompt, reasoning, scope, or evidence", () => {
  assert.doesNotMatch(hookSource, /createContinuationCapsule|formatContinuationCapsule|trust-boundary/);
  assert.doesNotMatch(hookSource, /readFileSync\([^\n]*transcript/i);
  assert.match(authoritySource, /FRESH_MILESTONE_NO_PREVIOUS_SCOPE_EVIDENCE_OR_TRANSCRIPT/);
  assert.match(authoritySource, /state:\s*"INTAKE"/);
  assert.match(authoritySource, /rmSync\(p\.activeContract/);
});

test("ARCH-O05: hooks are runtime-owned while session and Work Lease state remain project-owned", () => {
  assert.deepEqual(CODEX_MANAGED_RUNTIME_PATHS, [
    ".codex/config.toml",
    ".codex/hooks.json",
    ".codex/agents",
    ".codex/astra-orchestra",
  ]);
  assert.ok(CODEX_PRESERVED_PROJECT_PATHS.includes(".codex/orchestra-state"));
  assert.ok(CODEX_PRESERVED_PROJECT_PATHS.includes(".orchestra/state"));
  assert.equal(CODEX_MANAGED_RUNTIME_PATHS.includes(".codex/orchestra-state"), false);
  assert.equal(CODEX_MANAGED_RUNTIME_PATHS.includes(".orchestra/state"), false);
});

test("ARCH-O06: Codex authority implementation remains provider-isolated", () => {
  for (const source of [authoritySource, leaseSource, hookSource]) {
    assert.doesNotMatch(source, /(?:from|import|require)\s+["'][^"']*(?:runtimes[\\/]antigravity|\.agents[\\/])/i);
    assert.doesNotMatch(source, /gemini-|claude-|flash-orchestrator|ORCHESTRATOR_HANDOFF/);
  }
});
