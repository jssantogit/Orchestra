import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverDelegationProviders,
  inspectDelegationCapabilities,
} from "../../runtime/delegation/discovery.mjs";

function executor(provider, response) {
  return {
    provider,
    async discover() {
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("provider discovery is READY only when both cross-provider executors are factually available", async () => {
  const result = await discoverDelegationProviders({
    executors: [
      executor("antigravity", { available: true, provider: "antigravity", version: "agy 1.2.3" }),
      executor("codex", { available: true, provider: "codex", version: "codex 0.130.0" }),
    ],
  });

  assert.equal(result.status, "READY");
  assert.equal(result.availableCount, 2);
  assert.deepEqual(result.providers.map((entry) => entry.provider), ["antigravity", "codex"]);
});

test("provider discovery is DEGRADED when exactly one executor is available", async () => {
  const result = await discoverDelegationProviders({
    executors: [
      executor("antigravity", { available: true, provider: "antigravity", version: "agy 1.2.3" }),
      executor("codex", { available: false, provider: "codex", reason: "PROVIDER_UNAVAILABLE" }),
    ],
  });

  assert.equal(result.status, "DEGRADED");
  assert.equal(result.availableCount, 1);
  assert.equal(result.providers[1].reason, "PROVIDER_UNAVAILABLE");
});

test("provider discovery is UNAVAILABLE when no executor is available and converts thrown probes to bounded facts", async () => {
  const result = await discoverDelegationProviders({
    executors: [
      executor("antigravity", new Error("secret agy detail")),
      executor("codex", { available: false, provider: "codex", reason: "PROVIDER_UNAVAILABLE" }),
    ],
  });

  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.availableCount, 0);
  assert.deepEqual(result.providers[0], {
    available: false,
    provider: "antigravity",
    reason: "PROVIDER_UNAVAILABLE",
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("provider discovery rejects malformed executor composition instead of inferring readiness", async () => {
  await assert.rejects(
    discoverDelegationProviders({ executors: [{ provider: "codex" }] }),
    /DELEGATION_DISCOVERY_EXECUTOR_INVALID/,
  );
});

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

test("capability inspection checks Git worktree plus provider version/help without login or inference", async () => {
  const calls = [];
  const result = await inspectDelegationCapabilities({
    runProcess: async (input) => {
      calls.push({ command: input.command, args: input.args });
      if (input.command === "git") return processResult({ stdout: "worktree /repo\nHEAD abcdef\n" });
      if (input.command === "agy" && input.args[0] === "--version") return processResult({ stdout: "agy 1.2.3\n" });
      if (input.command === "agy") return processResult({ stdout: "--print --print-timeout --sandbox --model\n" });
      if (input.command === "codex" && input.args[0] === "--version") return processResult({ stdout: "codex-cli 0.130.0\n" });
      if (input.command === "codex") return processResult({ stdout: "--model --sandbox --ask-for-approval --config --output-schema --output-last-message\n" });
      throw new Error("unexpected command");
    },
  });

  assert.equal(result.status, "READY");
  assert.deepEqual(result.gitWorktree, { available: true });
  assert.equal(result.providers.every((provider) => provider.available), true);
  assert.deepEqual(calls, [
    { command: "git", args: ["worktree", "list", "--porcelain"] },
    { command: "agy", args: ["--version"] },
    { command: "agy", args: ["--help"] },
    { command: "codex", args: ["--version"] },
    { command: "codex", args: ["exec", "--help"] },
  ]);
});

test("capability inspection is DEGRADED for one missing optional provider but UNAVAILABLE without Git worktree", async () => {
  const oneProvider = await inspectDelegationCapabilities({
    runProcess: async (input) => {
      if (input.command === "git") return processResult();
      if (input.command === "agy") throw Object.assign(new Error("missing"), { code: "PROCESS_SPAWN_FAILED" });
      if (input.command === "codex" && input.args[0] === "--version") return processResult({ stdout: "codex-cli 0.130.0\n" });
      return processResult({ stdout: "--model --sandbox --ask-for-approval --config --output-schema --output-last-message\n" });
    },
  });
  assert.equal(oneProvider.status, "DEGRADED");
  assert.equal(oneProvider.gitWorktree.available, true);

  const noWorktree = await inspectDelegationCapabilities({
    runProcess: async (input) => {
      if (input.command === "git") return processResult({ exitCode: 1 });
      return processResult({ exitCode: 1 });
    },
  });
  assert.equal(noWorktree.status, "UNAVAILABLE");
  assert.deepEqual(noWorktree.gitWorktree, { available: false });
});
