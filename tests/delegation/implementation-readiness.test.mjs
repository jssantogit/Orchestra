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

function gitDiscovery(input) {
  if (input.command === "git" && input.args[0] === "worktree") {
    return processResult({ stdout: "worktree /repo\nHEAD abcdef\n" });
  }
  if (input.command === "git" && input.args[0] === "clone") {
    return processResult({
      exitCode: 129,
      stderr: "usage: git clone [<options>] <repo> [<dir>]\n    --no-hardlinks\n",
    });
  }
  return null;
}

test("Doctor readiness keeps review READY but degrades implementation when AGY lacks explicit edit mode", async () => {
  const result = await inspectDelegationCapabilities({
    runProcess: async (input) => {
      const git = gitDiscovery(input);
      if (git) return git;
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
  assert.deepEqual(result.modes.parallelImplementation, {
    status: "UNAVAILABLE",
    isolation: "EPHEMERAL_CLONE",
    memberCount: 2,
    artifactLifecycle: "CONTROL_OWNED_COMPOSITE",
  });
});

test("parallel implementation readiness is READY when AGY 1.3.5 help on stderr and Codex both expose implementation", async () => {
  const result = await inspectDelegationCapabilities({
    runProcess: async (input) => {
      const git = gitDiscovery(input);
      if (git) return git;
      if (input.command === "agy" && input.args[0] === "--version") {
        return processResult({ stdout: "agy 1.3.5\n" });
      }
      if (input.command === "agy") {
        return processResult({
          stdout: "",
          stderr: "--print --print-timeout --sandbox --model --mode\n",
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

  assert.equal(result.modes.implementation.status, "READY");
  assert.deepEqual(result.modes.parallelImplementation, {
    status: "READY",
    isolation: "EPHEMERAL_CLONE",
    memberCount: 2,
    artifactLifecycle: "CONTROL_OWNED_COMPOSITE",
  });
});
