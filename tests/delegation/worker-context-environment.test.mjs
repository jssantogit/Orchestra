import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

import { createCodexDelegationExecutor } from "../../providers/codex/delegation-executor.mjs";
import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";

function request(provider) {
  return {
    target: { provider, logicalRole: "CRITICAL_REVIEWER" },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536 },
  };
}

function envelope() {
  return { objective: "review candidate" };
}

function okResult(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

test("Codex worker execution carries non-recursive delegation context markers", async () => {
  let executionCall = null;
  const executor = createCodexDelegationExecutor({
    runProcess: async (input) => {
      executionCall = input;
      const outputIndex = input.args.indexOf("--output-last-message");
      writeFileSync(input.args[outputIndex + 1], JSON.stringify({ summary: "ok", findings: [], evidenceRefs: [] }), "utf8");
      return okResult();
    },
  });

  const result = await executor.execute({
    request: request("codex"),
    workerEnvelope: envelope(),
    workspace: { path: "/tmp/delegated-codex-worktree" },
  });

  assert.equal(result.ok, true);
  assert.equal(executionCall.env.ORCHESTRA_DELEGATION_ACTIVE, "1");
  assert.equal(executionCall.env.ORCHESTRA_DELEGATION_DEPTH, "1");
});

test("AGY worker execution carries non-recursive delegation context markers", async () => {
  let executionCall = null;
  const executor = createAntigravityDelegationExecutor({
    runProcess: async (input) => {
      executionCall = input;
      return okResult({ stdout: JSON.stringify({ summary: "ok", findings: [], evidenceRefs: [] }) });
    },
  });

  const result = await executor.execute({
    request: request("antigravity"),
    workerEnvelope: envelope(),
    workspace: { path: "/tmp/delegated-agy-worktree" },
  });

  assert.equal(result.ok, true);
  assert.equal(executionCall.env.ORCHESTRA_DELEGATION_ACTIVE, "1");
  assert.equal(executionCall.env.ORCHESTRA_DELEGATION_DEPTH, "1");
});
