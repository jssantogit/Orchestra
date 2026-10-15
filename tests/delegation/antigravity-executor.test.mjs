import test from "node:test";
import assert from "node:assert/strict";

import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";

function request() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "delegation-agy-1",
    taskId: "delegation-task",
    source: { provider: "codex", actorIdHash: "sha256:source" },
    target: { provider: "antigravity", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "delegation-task",
      candidateGeneration: 3,
      goal: "review the bounded candidate",
      direction: {
        change: "inspect the candidate against acceptance criteria",
        preserve: ["public API"],
      },
      anchors: [{ file: "src/example.mjs" }],
      scope: { allowedAreas: ["src/**", "test/**"], forbidden: ["secrets/**"] },
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

function workerEnvelope() {
  return {
    objective: "review the bounded candidate",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    context: {
      direction: { change: "inspect the candidate", preserve: ["public API"] },
      anchors: [{ file: "src/example.mjs" }],
      discovery: "DIRECTED",
      tests: "READ_ONLY",
    },
    scope: { allowedAreas: ["src/**"], forbidden: ["secrets/**"] },
    validation: ["focused tests"],
    capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
    prohibitions: { mutation: "FORBIDDEN", network: "FORBIDDEN", delegation: "FORBIDDEN" },
    outputContract: {
      schema: "orchestra.delegation-worker-report.v1",
      format: "JSON",
      additionalProperties: false,
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536 },
  };
}

function processResult(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    durationMs: 11,
    stdout: JSON.stringify({
      summary: "No blocking issue found.",
      findings: [],
      evidenceRefs: ["test:focused"],
    }),
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

test("AGY discovery verifies factual binary/version and required non-interactive flags without inference", async () => {
  const calls = [];
  const executor = createAntigravityDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      if (input.args.includes("--version")) return processResult({ stdout: "agy 2.0.0\n" });
      return processResult({
        stdout: "Usage of agy:\n  --print\n  --print-timeout\n  --sandbox\n  --model\n  --mode\n",
      });
    },
  });

  const discovery = await executor.discover();
  assert.deepEqual(discovery, {
    available: true,
    provider: "antigravity",
    version: "agy 2.0.0",
    capabilities: {
      print: true,
      printTimeout: true,
      sandbox: true,
      model: true,
      implementation: true,
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.args), [["--version"], ["--help"]]);
  assert.equal(calls.every((call) => call.command === "agy"), true);
});

test("AGY discovery fails closed when the binary is missing or required flags are unsupported", async () => {
  const missing = createAntigravityDelegationExecutor({
    runProcess: async () => {
      const error = new Error("PROCESS_SPAWN_FAILED");
      error.code = "PROCESS_SPAWN_FAILED";
      throw error;
    },
  });
  assert.deepEqual(await missing.discover(), {
    available: false,
    provider: "antigravity",
    reason: "PROVIDER_UNAVAILABLE",
  });

  const unsupported = createAntigravityDelegationExecutor({
    runProcess: async (input) => input.args.includes("--version")
      ? processResult({ stdout: "agy 2.0.0\n" })
      : processResult({ stdout: "Usage of agy:\n  --print\n  --print-timeout\n  --model\n" }),
  });
  assert.deepEqual(await unsupported.discover(), {
    available: false,
    provider: "antigravity",
    reason: "PROVIDER_UNAVAILABLE",
  });
});

test("AGY execution uses sandboxed print mode, provider-local model selection, and only the Worker Envelope", async () => {
  const calls = [];
  const executor = createAntigravityDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      return processResult();
    },
  });

  const result = await executor.execute({
    request: request(),
    workerEnvelope: workerEnvelope(),
    workspace: { path: "/tmp/orchestra-delegation-test" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "antigravity");
  assert.deepEqual(result.report, {
    summary: "No blocking issue found.",
    findings: [],
    evidenceRefs: ["test:focused"],
  });
  assert.deepEqual(result.execution, { exitCode: 0, durationMs: 11 });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.command, "agy");
  assert.equal(call.cwd, "/tmp/orchestra-delegation-test");
  assert.equal(call.timeoutMs, 120000);
  assert.equal(call.maxOutputBytes, 65536);
  assert.equal(call.args.includes("--sandbox"), true);
  assert.equal(call.args.includes("--print"), true);
  assert.equal(call.args.includes("--print-timeout"), true);
  assert.equal(call.args.includes("--model"), true);

  const modelIndex = call.args.indexOf("--model");
  assert.equal(call.args[modelIndex + 1], "gemini-3.8-flash-high");
  const promptIndex = call.args.indexOf("--print");
  const prompt = call.args[promptIndex + 1];
  assert.match(prompt, /review the bounded candidate/);
  assert.match(prompt, /FORBIDDEN/);
  assert.doesNotMatch(prompt, /orchestra\.delegation-request\.v1/);
  assert.doesNotMatch(prompt, /actorIdHash/);
  assert.doesNotMatch(prompt, /sourceFingerprint/);
});

test("AGY execution accepts exactly one bounded worker-report JSON document", async () => {
  for (const output of [
    "not-json",
    '{"summary":"ok","findings":[],"evidenceRefs":[]} trailing',
    '{"summary":"ok","findings":[],"evidenceRefs":[],"reasoning":"raw"}',
    '{"summary":"","findings":[],"evidenceRefs":[]}',
  ]) {
    const executor = createAntigravityDelegationExecutor({
      runProcess: async () => processResult({ stdout: output }),
    });
    const result = await executor.execute({
      request: request(),
      workerEnvelope: workerEnvelope(),
      workspace: { path: "/tmp/orchestra-delegation-test" },
    });
    assert.equal(result.ok, false, output);
    assert.equal(result.reason, "INVALID_RESULT", output);
    assert.deepEqual(Object.keys(result).sort(), ["execution", "ok", "provider", "reason"]);
  }

  const truncated = createAntigravityDelegationExecutor({
    runProcess: async () => processResult({ stdoutTruncated: true }),
  });
  const result = await truncated.execute({
    request: request(),
    workerEnvelope: workerEnvelope(),
    workspace: { path: "/tmp/orchestra-delegation-test" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVALID_RESULT");
});

test("AGY execution maps timeout, nonzero exit, and missing binary to bounded failure taxonomy", async () => {
  const timedOut = createAntigravityDelegationExecutor({
    runProcess: async () => processResult({ exitCode: null, signal: "SIGKILL", timedOut: true }),
  });
  assert.equal((await timedOut.execute({
    request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" },
  })).reason, "EXECUTION_TIMED_OUT");

  const nonzero = createAntigravityDelegationExecutor({
    runProcess: async () => processResult({ exitCode: 2, stderr: "provider detail" }),
  });
  const nonzeroResult = await nonzero.execute({
    request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" },
  });
  assert.equal(nonzeroResult.reason, "EXECUTION_FAILED");
  assert.equal(JSON.stringify(nonzeroResult).includes("provider detail"), false);

  const missing = createAntigravityDelegationExecutor({
    runProcess: async () => {
      const error = new Error("PROCESS_SPAWN_FAILED");
      error.code = "PROCESS_SPAWN_FAILED";
      throw error;
    },
  });
  const missingResult = await missing.execute({
    request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" },
  });
  assert.equal(missingResult.reason, "PROVIDER_UNAVAILABLE");
});
