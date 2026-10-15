import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";
import { createCodexDelegationExecutor } from "../../providers/codex/delegation-executor.mjs";

const WORKSPACE_PATH = "/tmp/orchestra-implementation-worker";
const WORKER_GIT_ENV = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/tmp/orchestra-empty-gitconfig",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_ALLOW_PROTOCOL: "",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/tmp/orchestra-empty-hooks",
  GIT_CONFIG_KEY_1: "protocol.allow",
  GIT_CONFIG_VALUE_1: "never",
});

function packet() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "task-provider-implementation-v2",
    candidateGeneration: 9,
    goal: "implement the bounded product change",
    direction: {
      cause: "explicit CONTROL implementation delegation",
      change: "modify the authorized source and tests",
      preserve: ["public API", "CONTROL authority"],
    },
    anchors: [{ file: "src/example.mjs", testHint: "node --test" }],
    scope: { allowedAreas: ["src/**", "tests/**"], forbidden: ["secrets/**"] },
    permissions: {
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
      sideEffects: ["WORKSPACE_EDIT", "LOCAL_TEST"],
    },
    validation: ["node --test"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function request(targetProvider) {
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: `implementation-${targetProvider}`,
    taskId: "task-provider-implementation-v2",
    source: {
      provider: targetProvider === "codex" ? "antigravity" : "codex",
      actorIdHash: "sha256:control",
    },
    target: { provider: targetProvider, logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: packet(),
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: "sha256:source",
      sourceRevision: "abcdef1234567890",
      isolation: "EPHEMERAL_CLONE",
      mutationScope: {
        allowedPaths: ["src/**", "tests/**"],
        forbiddenPaths: ["secrets/**"],
      },
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

function workerEnvelope() {
  return {
    objective: "implement the bounded product change",
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    context: {
      direction: {
        cause: "explicit CONTROL implementation delegation",
        change: "modify the authorized source and tests",
        preserve: ["public API", "CONTROL authority"],
      },
      anchors: [{ file: "src/example.mjs", testHint: "node --test" }],
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
    },
    scope: {
      allowedAreas: ["src/**", "tests/**"],
      forbidden: ["secrets/**", ".orchestra/state/**", ".git/**"],
      mutationScope: {
        allowedPaths: ["src/**", "tests/**"],
        forbiddenPaths: [".git/**", ".orchestra/state/**", "secrets/**"],
      },
    },
    validation: ["node --test"],
    capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
    prohibitions: { mutation: "WORKSPACE_ONLY", network: "FORBIDDEN", delegation: "FORBIDDEN" },
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
    durationMs: 17,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

function assertImplementationPrompt(prompt) {
  assert.match(prompt, /implementation worker/i);
  assert.match(prompt, /WORKSPACE_ONLY|workspace-only/i);
  assert.match(prompt, /allowedPaths/);
  assert.match(prompt, /forbiddenPaths/);
  assert.match(prompt, /Do not use network/i);
  assert.match(prompt, /Do not delegate/i);
  assert.match(prompt, /Do not create commits|Git history|Git metadata/i);
  assert.doesNotMatch(prompt, /Do not modify files|Do not modify source files/i);
  assert.doesNotMatch(prompt, /actorIdHash|sourceFingerprint|sourceRevision/);
}

function assertWorkerGitEnvironment(env) {
  for (const [key, value] of Object.entries(WORKER_GIT_ENV)) {
    assert.equal(env[key], value, key);
  }
  assert.equal(env.ORCHESTRA_DELEGATION_ACTIVE, "1");
  assert.equal(env.ORCHESTRA_DELEGATION_DEPTH, "1");
}

test("AGY v2 implementation executor uses isolated clone cwd, scoped mutation prompt, sandbox, and broker Git environment", async () => {
  const calls = [];
  const executor = createAntigravityDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      return processResult({
        stdout: JSON.stringify({ summary: "implementation complete", findings: [], evidenceRefs: ["test:focused"] }),
      });
    },
  });

  const result = await executor.execute({
    request: request("antigravity"),
    workerEnvelope: workerEnvelope(),
    workspace: { path: WORKSPACE_PATH, workerGitEnv: WORKER_GIT_ENV },
  });

  assert.equal(result.ok, true);
  const call = calls[0];
  assert.equal(call.cwd, WORKSPACE_PATH);
  assert.equal(call.args.includes("--sandbox"), true);
  assertWorkerGitEnvironment(call.env);
  assertImplementationPrompt(call.args[call.args.indexOf("--print") + 1]);
});

test("Codex v2 implementation executor uses isolated clone cwd, workspace-write sandbox, scoped mutation prompt, and broker Git environment", async () => {
  const calls = [];
  const executor = createCodexDelegationExecutor({
    runProcess: async (input) => {
      calls.push(input);
      const resultIndex = input.args.indexOf("--output-last-message");
      writeFileSync(input.args[resultIndex + 1], JSON.stringify({
        summary: "implementation complete",
        findings: [],
        evidenceRefs: ["test:focused"],
      }), "utf8");
      const schemaIndex = input.args.indexOf("--output-schema");
      JSON.parse(readFileSync(input.args[schemaIndex + 1], "utf8"));
      return processResult();
    },
  });

  const result = await executor.execute({
    request: request("codex"),
    workerEnvelope: workerEnvelope(),
    workspace: { path: WORKSPACE_PATH, workerGitEnv: WORKER_GIT_ENV },
  });

  assert.equal(result.ok, true);
  const call = calls[0];
  assert.equal(call.cwd, WORKSPACE_PATH);
  assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "workspace-write");
  assertWorkerGitEnvironment(call.env);
  assertImplementationPrompt(call.input);
});

test("v2 execution fails closed without broker-owned Git isolation environment", async () => {
  const agy = createAntigravityDelegationExecutor({
    runProcess: async () => processResult({
      stdout: JSON.stringify({ summary: "unexpected", findings: [], evidenceRefs: [] }),
    }),
  });
  const codex = createCodexDelegationExecutor({
    runProcess: async () => processResult(),
  });

  for (const [provider, executor] of [["antigravity", agy], ["codex", codex]]) {
    const result = await executor.execute({
      request: request(provider),
      workerEnvelope: workerEnvelope(),
      workspace: { path: WORKSPACE_PATH },
    });
    assert.equal(result.ok, false, provider);
    assert.equal(result.reason, "CAPABILITY_DENIED", provider);
  }
});

test("v2 worker reports cannot fabricate broker-owned artifact facts", async () => {
  const fabricated = {
    summary: "implementation complete",
    findings: [],
    evidenceRefs: [],
    artifact: { artifactId: "forged", state: "READY_FOR_REVIEW" },
  };

  const agy = createAntigravityDelegationExecutor({
    runProcess: async () => processResult({ stdout: JSON.stringify(fabricated) }),
  });
  const agyResult = await agy.execute({
    request: request("antigravity"),
    workerEnvelope: workerEnvelope(),
    workspace: { path: WORKSPACE_PATH, workerGitEnv: WORKER_GIT_ENV },
  });
  assert.equal(agyResult.reason, "INVALID_RESULT");

  const codex = createCodexDelegationExecutor({
    runProcess: async (input) => {
      const resultIndex = input.args.indexOf("--output-last-message");
      writeFileSync(input.args[resultIndex + 1], JSON.stringify(fabricated), "utf8");
      return processResult();
    },
  });
  const codexResult = await codex.execute({
    request: request("codex"),
    workerEnvelope: workerEnvelope(),
    workspace: { path: WORKSPACE_PATH, workerGitEnv: WORKER_GIT_ENV },
  });
  assert.equal(codexResult.reason, "INVALID_RESULT");
});
