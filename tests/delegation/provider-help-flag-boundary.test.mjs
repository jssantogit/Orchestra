import test from "node:test";
import assert from "node:assert/strict";

import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";
import { createCodexDelegationExecutor } from "../../providers/codex/delegation-executor.mjs";

function result(stdout) {
  return {
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
  };
}

test("AGY discovery does not mistake --print-timeout for the required --print flag", async () => {
  const executor = createAntigravityDelegationExecutor({
    runProcess: async (input) => input.args.includes("--version")
      ? result("agy 2.0.0\n")
      : result("--print-timeout --sandbox --model --mode\n"),
  });

  assert.deepEqual(await executor.discover(), {
    available: false,
    provider: "antigravity",
    reason: "PROVIDER_UNAVAILABLE",
  });
});

test("Codex discovery does not mistake a prefixed option for the required --model flag", async () => {
  const executor = createCodexDelegationExecutor({
    runProcess: async (input) => input.args.includes("--version")
      ? result("codex-cli 0.130.0\n")
      : result("--model-provider --sandbox --config --output-schema --output-last-message\n"),
  });

  assert.deepEqual(await executor.discover(), {
    available: false,
    provider: "codex",
    reason: "PROVIDER_UNAVAILABLE",
  });
});
