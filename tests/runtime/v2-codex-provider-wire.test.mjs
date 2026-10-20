import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderCodexV2Shim } from "../../v2/providers/codex/shim-template.mjs";

function runShim(internalResponse, hookInput) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-codex-provider-wire-"));
  const launcher = join(root, "launcher.mjs");
  const shim = join(root, "shim.mjs");
  try {
    writeFileSync(launcher, `process.stdout.write(${JSON.stringify(JSON.stringify(internalResponse))});\nprocess.exitCode = ${internalResponse.ok ? 0 : 1};\n`);
    writeFileSync(shim, renderCodexV2Shim({ launcherPath: launcher, nodePath: process.execPath }));
    const result = spawnSync(process.execPath, [shim], {
      cwd: root,
      input: JSON.stringify(hookInput),
      encoding: "utf8",
    });
    return { ...result, payload: JSON.parse(result.stdout) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Codex PreToolUse deny exposes only the closed provider wire schema", () => {
  const result = runShim({
    ok: false,
    reason: "SESSION_RUNTIME_STALE",
    currentInstructionEpoch: 6,
    continuationAvailable: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: JSON.stringify({
        reason: "SESSION_RUNTIME_STALE",
        currentInstructionEpoch: 6,
        continuationAvailable: true,
      }),
    },
  }, {
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_use_id: "provider-wire-deny",
    tool_input: { command: "*** Begin Patch\n*** End Patch" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.payload, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: JSON.stringify({
        reason: "SESSION_RUNTIME_STALE",
        currentInstructionEpoch: 6,
        continuationAvailable: true,
      }),
    },
  });
});

test("Codex PreToolUse allow omits unsupported permissionDecision allow without updatedInput", () => {
  const result = runShim({
    ok: true,
    reason: null,
    projectId: "prj_internal_only",
    operation: { operationId: "op_internal_only" },
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: JSON.stringify({ reason: null, projectId: "prj_internal_only" }),
    },
  }, {
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_use_id: "provider-wire-allow",
    tool_input: { command: "*** Begin Patch\n*** End Patch" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.payload, {
    hookSpecificOutput: { hookEventName: "PreToolUse" },
  });
});

test("Codex SessionStart and PostToolUse never receive Orchestra internal envelope fields", () => {
  const session = runShim({
    ok: true,
    reason: "ACTIVE_WORK",
    projectId: "prj_internal_only",
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: JSON.stringify({ state: "ACTIVE_WORK" }),
    },
  }, {
    hook_event_name: "SessionStart",
    session_id: "provider-wire-session",
  });
  assert.equal(session.status, 0);
  assert.deepEqual(session.payload, {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: JSON.stringify({ state: "ACTIVE_WORK" }),
    },
  });

  const post = runShim({
    ok: true,
    reason: null,
    projectId: "prj_internal_only",
    operation: { operationId: "op_internal_only", workflowState: "SUCCEEDED", liveness: "TERMINAL" },
  }, {
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_use_id: "provider-wire-post",
    tool_input: { command: "*** Begin Patch\n*** End Patch" },
    tool_response: "Done!",
  });
  assert.equal(post.status, 0);
  assert.deepEqual(post.payload, {});
});
