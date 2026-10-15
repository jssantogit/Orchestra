import test from "node:test";
import assert from "node:assert/strict";

import { inspectDelegationCapabilities } from "../../runtime/delegation/discovery.mjs";

function processResult(overrides = {}) {
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

test("Doctor readiness keeps review READY but degrades implementation when AGY lacks explicit edit mode", async () => {
  const result = await inspectDelegationCapabilities({
    runProcess: async (input) => {
      if (input.command === "git" && input.args[0] === "worktree") {
        return processResult({ stdout: "worktree /repo\nHEAD abcdef\n" });
      }
      if (input.command === "git" && input.args[0] === "clone") {
        return processResult({
          exitCode: 129,
          stderr: "usage: git clone [<options>] <repo> [<dir>]\n    --no-hardlinks\n",
        });
      }
      if (input.command === "agy" && input.args[0] === "--version") {
        return processResult({ stdout: "agy 1.0.0\n" });
      }
      if (input.command === "agy") {
        return processResult({
          stdout: "--print --print-timeout --sandbox --model\n",
        });
      }
      if (input.command === "codex" && input.args[0] === "--version") {
        return processResult({ stdout: "codex-cli 0.130.0\n" });
      }
      if (input.command === "codex") {
        return processResult({
          stdout: "--model --sandbox --config --output-schema --output-last-message\n",
        });
      }
      throw new Error("unexpected command");
    },
  });

  const agy = result.providers.find((provider) => provider.provider === "antigravity");
  const codex = result.providers.find((provider) => provider.provider === "codex");

  assert.equal(agy.available, true);
  assert.equal(agy.capabilities.implementation, false);
  assert.equal(codex.available, true);
  assert.equal(codex.capabilities.implementation, true);
  assert.equal(result.modes.review.status, "READY");
  assert.equal(result.modes.implementation.status, "DEGRADED");
});
