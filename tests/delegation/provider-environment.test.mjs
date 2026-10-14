import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

import { createCodexDelegationExecutor } from "../../providers/codex/delegation-executor.mjs";
import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";

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

function request(targetProvider) {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: `delegation-env-${targetProvider}`,
    taskId: "delegation-env-task",
    source: { provider: targetProvider === "codex" ? "antigravity" : "codex", actorIdHash: "sha256:source" },
    target: { provider: targetProvider, logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "delegation-env-task",
      candidateGeneration: 1,
      goal: "review candidate",
      direction: { change: "inspect candidate", preserve: [] },
      anchors: [{ file: "src/example.mjs" }],
      scope: { allowedAreas: ["src/**"], forbidden: [] },
      permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: ["LOCAL_TEST"] },
      validation: ["focused tests"],
      failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
    },
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
      mutation: "FORBIDDEN",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: "sha256:fingerprint",
      sourceRevision: "abcdef1234567890",
      isolation: "EPHEMERAL_WORKTREE",
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

function envelope() {
  return {
    objective: "review candidate",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    context: {
      direction: { change: "inspect candidate", preserve: [] },
      anchors: [{ file: "src/example.mjs" }],
      discovery: "DIRECTED",
      tests: "READ_ONLY",
    },
    scope: { allowedAreas: ["src/**"], forbidden: [] },
    validation: ["focused tests"],
    capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
    prohibitions: { mutation: "FORBIDDEN", network: "FORBIDDEN", delegation: "FORBIDDEN" },
    outputContract: { schema: "orchestra.delegation-worker-report.v1", format: "JSON", additionalProperties: false },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536 },
  };
}

function assertCommonEnvironment(env) {
  assert.equal(typeof env, "object");
  if (process.env.PATH !== undefined) assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.GIT_ASKPASS, undefined);
  assert.equal(env.ORCHESTRA_CONTROL_SECRET, undefined);
}

test("Codex subprocesses receive only operational environment plus Codex credentials", async (t) => {
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) process.env[key] = value;
  });
  Object.assign(process.env, {
    OPENAI_API_KEY: "codex-secret",
    GEMINI_API_KEY: "agy-secret",
    GITHUB_TOKEN: "repo-secret",
    GH_TOKEN: "repo-secret-2",
    NPM_TOKEN: "publish-secret",
    ORCHESTRA_CONTROL_SECRET: "control-secret",
  });

  const calls = [];
  const executor = createCodexDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      if (input.args.includes("--version")) return processResult({ stdout: "codex-cli 0.130.0\n" });
      if (input.args.includes("--help")) return processResult({ stdout: "--model --sandbox --config --output-schema --output-last-message" });
      const outputIndex = input.args.indexOf("--output-last-message");
      writeFileSync(input.args[outputIndex + 1], JSON.stringify({ summary: "ok", findings: [], evidenceRefs: [] }), "utf8");
      return processResult();
    },
  });

  assert.equal((await executor.discover()).available, true);
  assert.equal((await executor.execute({ request: request("codex"), workerEnvelope: envelope(), workspace: { path: "/tmp/worktree" } })).ok, true);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assertCommonEnvironment(call.env);
    assert.equal(call.env.OPENAI_API_KEY, "codex-secret");
    assert.equal(call.env.GEMINI_API_KEY, undefined);
  }
});

test("AGY subprocesses receive only operational environment plus Google credentials", async (t) => {
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) process.env[key] = value;
  });
  Object.assign(process.env, {
    OPENAI_API_KEY: "codex-secret",
    GEMINI_API_KEY: "agy-secret",
    GOOGLE_API_KEY: "google-secret",
    GITHUB_TOKEN: "repo-secret",
    NPM_TOKEN: "publish-secret",
    ORCHESTRA_CONTROL_SECRET: "control-secret",
  });

  const calls = [];
  const executor = createAntigravityDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      if (input.args.includes("--version")) return processResult({ stdout: "agy 2.0.0\n" });
      if (input.args.includes("--help")) return processResult({ stdout: "--print --print-timeout --sandbox --model" });
      return processResult({ stdout: JSON.stringify({ summary: "ok", findings: [], evidenceRefs: [] }) });
    },
  });

  assert.equal((await executor.discover()).available, true);
  assert.equal((await executor.execute({ request: request("antigravity"), workerEnvelope: envelope(), workspace: { path: "/tmp/worktree" } })).ok, true);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assertCommonEnvironment(call.env);
    assert.equal(call.env.GEMINI_API_KEY, "agy-secret");
    assert.equal(call.env.GOOGLE_API_KEY, "google-secret");
    assert.equal(call.env.OPENAI_API_KEY, undefined);
  }
});
