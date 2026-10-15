import test from "node:test";
import assert from "node:assert/strict";

import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";

function processResult(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    durationMs: 11,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

function expectedAvailable() {
  return {
    available: true,
    provider: "antigravity",
    version: "agy 1.3.5",
    capabilities: {
      print: true,
      printTimeout: true,
      sandbox: true,
      model: true,
      implementation: true,
    },
  };
}

function unavailable() {
  return {
    available: false,
    provider: "antigravity",
    reason: "PROVIDER_UNAVAILABLE",
  };
}

test("AGY discovery accepts required help flags emitted entirely on stderr", async () => {
  const executor = createAntigravityDelegationExecutor({
    runProcess: async (input) => input.args.includes("--version")
      ? processResult({ stdout: "agy 1.3.5\n" })
      : processResult({
        stderr: "Usage of agy:\n  --print\n  --print-timeout\n  --sandbox\n  --model\n  --mode\n",
      }),
  });

  assert.deepEqual(await executor.discover(), expectedAvailable());
});

test("AGY discovery accepts required help flags split across stdout and stderr", async () => {
  const executor = createAntigravityDelegationExecutor({
    runProcess: async (input) => input.args.includes("--version")
      ? processResult({ stdout: "agy 1.3.5\n" })
      : processResult({
        stdout: "Usage of agy:\n  --print\n  --sandbox\n",
        stderr: "  --print-timeout\n  --model\n  --mode\n",
      }),
  });

  assert.deepEqual(await executor.discover(), expectedAvailable());
});

test("AGY discovery fails closed when stderr help is truncated", async () => {
  const executor = createAntigravityDelegationExecutor({
    runProcess: async (input) => input.args.includes("--version")
      ? processResult({ stdout: "agy 1.3.5\n" })
      : processResult({
        stderr: "Usage of agy:\n  --print\n  --print-timeout\n  --sandbox\n  --model\n  --mode\n",
        stderrTruncated: true,
      }),
  });

  assert.deepEqual(await executor.discover(), unavailable());
});

test("AGY discovery retains timeout and nonzero-exit fail-closed behavior", async () => {
  for (const helpResult of [
    processResult({ timedOut: true, exitCode: null, signal: "SIGKILL" }),
    processResult({ exitCode: 2, stderr: "usage failure" }),
  ]) {
    const executor = createAntigravityDelegationExecutor({
      runProcess: async (input) => input.args.includes("--version")
        ? processResult({ stdout: "agy 1.3.5\n" })
        : helpResult,
    });

    assert.deepEqual(await executor.discover(), unavailable());
  }
});
