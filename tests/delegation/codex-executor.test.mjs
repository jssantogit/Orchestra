import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { createCodexDelegationExecutor } from "../../providers/codex/delegation-executor.mjs";

function request() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "delegation-codex-1",
    taskId: "delegation-task",
    source: { provider: "antigravity", actorIdHash: "sha256:source" },
    target: { provider: "codex", logicalRole: "CRITICAL_REVIEWER" },
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
    durationMs: 13,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

function writeReportForCall(call, report = {
  summary: "No blocking issue found.",
  findings: [],
  evidenceRefs: ["test:focused"],
}) {
  const index = call.args.indexOf("--output-last-message");
  assert.notEqual(index, -1);
  writeFileSync(call.args[index + 1], JSON.stringify(report), "utf8");
}

test("Codex discovery verifies factual binary/version and required headless flags without inference", async () => {
  const calls = [];
  const executor = createCodexDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      if (input.args.includes("--version")) return processResult({ stdout: "codex-cli 0.130.0\n" });
      return processResult({
        stdout: "Usage: codex exec\n  --model\n  --sandbox\n  --ask-for-approval\n  --config\n  --output-schema\n  --output-last-message\n",
      });
    },
  });

  const discovery = await executor.discover();
  assert.equal(discovery.available, true);
  assert.equal(discovery.provider, "codex");
  assert.equal(discovery.version, "codex-cli 0.130.0");
  assert.deepEqual(calls.map((call) => call.args), [["--version"], ["exec", "--help"]]);
  assert.equal(calls.every((call) => call.command === "codex"), true);
});

test("Codex discovery fails closed when binary or required headless flags are unavailable", async () => {
  const missing = createCodexDelegationExecutor({
    runProcess: async () => {
      const error = new Error("PROCESS_SPAWN_FAILED");
      error.code = "PROCESS_SPAWN_FAILED";
      throw error;
    },
  });
  assert.equal((await missing.discover()).available, false);

  const unsupported = createCodexDelegationExecutor({
    runProcess: async (input) => input.args.includes("--version")
      ? processResult({ stdout: "codex-cli 0.130.0\n" })
      : processResult({ stdout: "Usage: codex exec\n  --model\n  --sandbox\n" }),
  });
  assert.deepEqual(await unsupported.discover(), {
    available: false,
    provider: "codex",
    reason: "PROVIDER_UNAVAILABLE",
  });
});

test("Codex execution uses isolated workspace-write sandbox, never approval, provider-local model profile, schema output, and only Worker Envelope stdin", async () => {
  const calls = [];
  let outputSchema = null;
  const executor = createCodexDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      const schemaIndex = input.args.indexOf("--output-schema");
      outputSchema = JSON.parse(readFileSync(input.args[schemaIndex + 1], "utf8"));
      writeReportForCall(input);
      return processResult();
    },
  });

  const result = await executor.execute({
    request: request(),
    workerEnvelope: workerEnvelope(),
    workspace: { path: "/tmp/orchestra-delegation-test" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "codex");
  assert.deepEqual(result.report, {
    summary: "No blocking issue found.",
    findings: [],
    evidenceRefs: ["test:focused"],
  });
  assert.deepEqual(result.execution, { exitCode: 0, durationMs: 13 });
  assert.deepEqual(outputSchema.required, ["summary", "findings", "evidenceRefs"]);
  assert.equal(outputSchema.additionalProperties, false);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.command, "codex");
  assert.equal(call.cwd, "/tmp/orchestra-delegation-test");
  assert.equal(call.timeoutMs, 120000);
  assert.equal(call.maxOutputBytes, 65536);
  assert.equal(call.args[0], "exec");
  assert.equal(call.args.includes("--sandbox"), true);
  assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(call.args[call.args.indexOf("--ask-for-approval") + 1], "never");
  assert.equal(call.args[call.args.indexOf("--model") + 1], "gpt-6-sol");
  assert.equal(call.args.includes("model_reasoning_effort=low"), true);
  assert.equal(call.args.includes("--output-schema"), true);
  assert.equal(call.args.includes("--output-last-message"), true);
  assert.equal(call.args.at(-1), "-");
  assert.match(call.input, /review the bounded candidate/);
  assert.match(call.input, /FORBIDDEN/);
  assert.doesNotMatch(call.input, /orchestra\.delegation-request\.v1/);
  assert.doesNotMatch(call.input, /actorIdHash/);
  assert.doesNotMatch(call.input, /sourceFingerprint/);
});

test("Codex execution accepts exactly one bounded worker report from the result file", async () => {
  for (const report of [
    "not-json",
    '{"summary":"ok","findings":[],"evidenceRefs":[]} trailing',
    '{"summary":"ok","findings":[],"evidenceRefs":[],"reasoning":"raw"}',
    '{"summary":"","findings":[],"evidenceRefs":[]}',
  ]) {
    const executor = createCodexDelegationExecutor({
      runProcess: async (input) => {
        const index = input.args.indexOf("--output-last-message");
        writeFileSync(input.args[index + 1], report, "utf8");
        return processResult();
      },
    });
    const result = await executor.execute({
      request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" },
    });
    assert.equal(result.ok, false, report);
    assert.equal(result.reason, "INVALID_RESULT", report);
  }
});

test("Codex execution maps timeout, nonzero exit, truncated output and missing binary to bounded failure taxonomy", async () => {
  const timedOut = createCodexDelegationExecutor({
    runProcess: async () => processResult({ exitCode: null, signal: "SIGKILL", timedOut: true }),
  });
  assert.equal((await timedOut.execute({
    request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" },
  })).reason, "EXECUTION_TIMED_OUT");

  const nonzero = createCodexDelegationExecutor({
    runProcess: async () => processResult({ exitCode: 2, stderr: "provider detail" }),
  });
  const nonzeroResult = await nonzero.execute({
    request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" },
  });
  assert.equal(nonzeroResult.reason, "EXECUTION_FAILED");
  assert.equal(JSON.stringify(nonzeroResult).includes("provider detail"), false);

  const truncated = createCodexDelegationExecutor({
    runProcess: async () => processResult({ stdoutTruncated: true }),
  });
  assert.equal((await truncated.execute({
    request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" },
  })).reason, "INVALID_RESULT");

  const missing = createCodexDelegationExecutor({
    runProcess: async () => {
      const error = new Error("PROCESS_SPAWN_FAILED");
      error.code = "PROCESS_SPAWN_FAILED";
      throw error;
    },
  });
  assert.equal((await missing.execute({
    request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" },
  })).reason, "PROVIDER_UNAVAILABLE");
});
