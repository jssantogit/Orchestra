import test from "node:test";
import assert from "node:assert/strict";

import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";

function implementationRequest() {
  return {
    schema: "orchestra.delegation-request.v2",
    target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536 },
  };
}

function workerGitEnv() {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/tmp/orchestra-empty-gitconfig",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/tmp/orchestra-empty-hooks",
    GIT_CONFIG_KEY_1: "protocol.allow",
    GIT_CONFIG_VALUE_1: "never",
  };
}

function successfulProcessResult() {
  return {
    exitCode: 0,
    signal: null,
    durationMs: 11,
    stdout: JSON.stringify({
      summary: "Implementation completed in the isolated clone.",
      findings: [],
      evidenceRefs: [],
    }),
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
  };
}

test("AGY v2 pins accept-edits mode instead of inheriting interactive or plan defaults", async () => {
  const calls = [];
  const executor = createAntigravityDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      return successfulProcessResult();
    },
  });

  const result = await executor.execute({
    request: implementationRequest(),
    workerEnvelope: { objective: "edit the authorized file" },
    workspace: {
      path: "/tmp/orchestra-implementation-clone",
      workerGitEnv: workerGitEnv(),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.equal(args.includes("--sandbox"), true);
  assert.equal(args.includes("--mode=accept-edits"), true);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});
