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
      direction: { change: "inspect the candidate", preserve: ["public API"] },
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
    outputContract: { schema: "orchestra.delegation-worker-report.v1", format: "JSON", additionalProperties: false },
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

function writeReport(call, value = { summary: "No blocking issue found.", findings: [], evidenceRefs: ["test:focused"] }) {
  const index = call.args.indexOf("--output-last-message");
  assert.notEqual(index, -1);
  writeFileSync(call.args[index + 1], typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

test("Codex discovery verifies only exec-supported headless flags without inference", async () => {
  const calls = [];
  const executor = createCodexDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      if (input.args.includes("--version")) return processResult({ stdout: "codex-cli 0.130.0\n" });
      return processResult({ stdout: "Usage: codex exec\n --model --sandbox --config --output-schema --output-last-message\n" });
    },
  });
  const discovery = await executor.discover();
  assert.equal(discovery.available, true);
  assert.equal(discovery.provider, "codex");
  assert.equal(discovery.version, "codex-cli 0.130.0");
  assert.deepEqual(calls.map((call) => call.args), [["--version"], ["exec", "--help"]]);
});

test("Codex discovery fails closed when binary or required exec flags are unavailable", async () => {
  const missing = createCodexDelegationExecutor({
    runProcess: async () => { throw Object.assign(new Error("missing"), { code: "PROCESS_SPAWN_FAILED" }); },
  });
  assert.equal((await missing.discover()).available, false);

  const unsupported = createCodexDelegationExecutor({
    runProcess: async (input) => input.args.includes("--version")
      ? processResult({ stdout: "codex-cli 0.130.0\n" })
      : processResult({ stdout: "Usage: codex exec\n --model --sandbox\n" }),
  });
  assert.equal((await unsupported.discover()).available, false);
});

test("Codex execution uses isolated workspace-write, explicit no-approval config, provider-local model profile, schema output, and only Worker Envelope stdin", async () => {
  const calls = [];
  let outputSchema = null;
  const executor = createCodexDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      const schemaIndex = input.args.indexOf("--output-schema");
      outputSchema = JSON.parse(readFileSync(input.args[schemaIndex + 1], "utf8"));
      writeReport(input);
      return processResult();
    },
  });

  const result = await executor.execute({ request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" } });
  assert.equal(result.ok, true);
  assert.deepEqual(outputSchema.required, ["summary", "findings", "evidenceRefs"]);
  assert.equal(outputSchema.additionalProperties, false);

  const call = calls[0];
  assert.equal(call.command, "codex");
  assert.equal(call.cwd, "/tmp/worktree");
  assert.equal(call.args[0], "exec");
  assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(call.args.includes("--ask-for-approval"), false);
  const configValues = call.args.filter((arg, index) => call.args[index - 1] === "--config");
  assert.equal(configValues.includes("approval_policy=never"), true);
  assert.equal(configValues.includes("model_reasoning_effort=low"), true);
  assert.equal(call.args[call.args.indexOf("--model") + 1], "gpt-6-sol");
  assert.equal(call.args.at(-1), "-");
  assert.match(call.input, /review the bounded candidate/);
  assert.match(call.input, /FORBIDDEN/);
  assert.doesNotMatch(call.input, /orchestra\.delegation-request\.v1|actorIdHash|sourceFingerprint/);
});

test("Codex execution accepts exactly one bounded worker report and maps malformed output to INVALID_RESULT", async () => {
  for (const report of [
    "not-json",
    '{"summary":"ok","findings":[],"evidenceRefs":[]} trailing',
    '{"summary":"ok","findings":[],"evidenceRefs":[],"reasoning":"raw"}',
    '{"summary":"","findings":[],"evidenceRefs":[]}',
  ]) {
    const executor = createCodexDelegationExecutor({
      runProcess: async (input) => { writeReport(input, report); return processResult(); },
    });
    const result = await executor.execute({ request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" } });
    assert.equal(result.ok, false, report);
    assert.equal(result.reason, "INVALID_RESULT", report);
  }
});

test("Codex strict output wire omits unsupported uniqueItems without relaxing local report validation", async () => {
  let outputSchema;
  const executor = createCodexDelegationExecutor({
    runProcess: async input => {
      const schemaPath = input.args[input.args.indexOf("--output-schema") + 1];
      outputSchema = JSON.parse(readFileSync(schemaPath, "utf8"));
      writeReport(input, { summary: "Completed", findings: [], evidenceRefs: ["test:same", "test:same"] });
      return processResult();
    },
  });
  const result = await executor.execute({ request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" } });
  assert.equal(Object.hasOwn(outputSchema.properties.evidenceRefs, "uniqueItems"), false);
  assert.equal(outputSchema.additionalProperties, false);
  assert.deepEqual(outputSchema.required, ["summary", "findings", "evidenceRefs"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVALID_RESULT");
});

test("Codex execution maps timeout, nonzero, truncation, and missing binary to bounded failure taxonomy", async () => {
  const cases = [
    [processResult({ exitCode: null, signal: "SIGKILL", timedOut: true }), "EXECUTION_TIMED_OUT"],
    [processResult({ exitCode: 2, stderr: "provider detail" }), "EXECUTION_FAILED"],
    [processResult({ stdoutTruncated: true }), "INVALID_RESULT"],
  ];
  for (const [process, expected] of cases) {
    const executor = createCodexDelegationExecutor({ runProcess: async () => process });
    const result = await executor.execute({ request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" } });
    assert.equal(result.reason, expected);
    assert.equal(JSON.stringify(result).includes("provider detail"), false);
  }

  const missing = createCodexDelegationExecutor({
    runProcess: async () => { throw Object.assign(new Error("missing"), { code: "PROCESS_SPAWN_FAILED" }); },
  });
  const result = await missing.execute({ request: request(), workerEnvelope: workerEnvelope(), workspace: { path: "/tmp/worktree" } });
  assert.equal(result.reason, "PROVIDER_UNAVAILABLE");
});
