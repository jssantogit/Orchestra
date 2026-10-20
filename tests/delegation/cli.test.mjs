import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDelegationCli } from "../../runtime/delegation/cli.mjs";

function request() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "cli-delegation",
    taskId: "cli-task",
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "cli-task",
      candidateGeneration: 1,
      goal: "review the bounded candidate",
      direction: { change: "inspect", preserve: ["public API"] },
      anchors: [{ file: "src/example.mjs" }],
      scope: { allowedAreas: ["src/**"], forbidden: ["secrets/**"] },
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

function completedResult() {
  return {
    schema: "orchestra.delegation-result.v1",
    delegationId: "cli-delegation",
    provider: "antigravity",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    status: "COMPLETED",
    summary: "No blocking issue found.",
    findings: [],
    evidenceRefs: ["worker:test:focused"],
    execution: { exitCode: 0, durationMs: 8 },
    workspace: {
      initialFingerprint: "sha256:initial",
      finalFingerprint: "sha256:final",
      dirty: false,
    },
  };
}

function capture() {
  let value = "";
  return {
    write(chunk) { value += String(chunk); },
    value() { return value; },
  };
}

test('CLI preserves bounded resource deferral instead of reporting generic execution failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-resource-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'request.json');
  writeFileSync(path, JSON.stringify(request()));
  const stdout = capture(), stderr = capture();
  const code = await runDelegationCli({ argv: ['--request', path, '--repo-root', root, '--generation', '7'], stdout, stderr,
    createExecutor: () => ({ provider: 'antigravity' }),
    createBroker: () => ({ executeDelegation: async () => ({ ok: false, status: 'DEFERRED', reason: 'RESOURCE_BUDGET_UNAVAILABLE' }) }),
  });
  assert.equal(code, 2);
  assert.equal(stderr.value(), 'RESOURCE_BUDGET_UNAVAILABLE\n');
  assert.equal(stdout.value(), '');
});

test("source CLI reads one canonical request file, supplies bounded CONTROL context, and emits exactly one result JSON", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, `${JSON.stringify(request())}\n`);

  let receivedRequest = null;
  let receivedContext = null;
  let executorCount = null;
  const stdout = capture();
  const stderr = capture();

  const code = await runDelegationCli({
    argv: ["--request", requestPath, "--repo-root", root, "--generation", "7"],
    stdout,
    stderr,
    createExecutor: () => ({ provider: "antigravity" }),
    createBroker: ({ executors }) => {
      executorCount = executors.length;
      return {
        async executeDelegation(input, context) {
          receivedRequest = input;
          receivedContext = context;
          return completedResult();
        },
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(stderr.value(), "");
  assert.equal(executorCount, 1);
  assert.deepEqual(receivedRequest, request());
  assert.deepEqual(receivedContext, {
    repoRoot: root,
    generation: 7,
    actor: {
      provider: "codex",
      actorIdHash: "sha256:control",
      actorKind: "ROOT",
      isRoot: true,
    },
  });
  assert.equal(stdout.value(), `${JSON.stringify(completedResult())}\n`);
  assert.deepEqual(JSON.parse(stdout.value()), completedResult());
});

test("source CLI treats canonical non-success results as successful transport and still emits only the result", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, `${JSON.stringify(request())}\n`);
  const denied = {
    ...completedResult(),
    status: "DENIED",
    reason: "CAPABILITY_DENIED",
    summary: "",
    evidenceRefs: [],
    execution: { exitCode: null, durationMs: 0 },
    workspace: { initialFingerprint: null, finalFingerprint: null, dirty: null },
  };
  const stdout = capture();
  const stderr = capture();

  const code = await runDelegationCli({
    argv: ["--request", requestPath, "--repo-root", root, "--generation", "0"],
    stdout,
    stderr,
    createExecutor: () => ({ provider: "antigravity" }),
    createBroker: () => ({ async executeDelegation() { return denied; } }),
  });

  assert.equal(code, 0);
  assert.equal(stderr.value(), "");
  assert.equal(stdout.value(), `${JSON.stringify(denied)}\n`);
});

test("source CLI fails closed on invalid usage or request JSON without printing provider/runtime detail to stdout", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const malformedPath = join(root, "malformed.json");
  writeFileSync(malformedPath, "{not-json\n");

  for (const argv of [
    [],
    ["--request", malformedPath, "--repo-root", root, "--generation", "1"],
    ["--request", malformedPath, "--repo-root", root, "--generation", "-1"],
    ["--request", malformedPath, "--repo-root", root, "--generation", "not-a-number"],
  ]) {
    const stdout = capture();
    const stderr = capture();
    const code = await runDelegationCli({
      argv,
      stdout,
      stderr,
      createExecutor: () => { throw new Error("secret provider detail"); },
      createBroker: () => { throw new Error("secret broker detail"); },
    });
    assert.equal(code, 2, JSON.stringify(argv));
    assert.equal(stdout.value(), "", JSON.stringify(argv));
    assert.match(stderr.value(), /^ORCHESTRA_DELEGATION_CLI_[A-Z_]+\n$/, JSON.stringify(argv));
    assert.equal(stderr.value().includes("secret"), false);
  }
});

test("source CLI rejects a request whose target is not represented by the composed executor", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = request();
  candidate.target.provider = "provider-without-executor";
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, `${JSON.stringify(candidate)}\n`);
  const stdout = capture();
  const stderr = capture();

  const code = await runDelegationCli({
    argv: ["--request", requestPath, "--repo-root", root, "--generation", "1"],
    stdout,
    stderr,
    createExecutor: () => ({ provider: "antigravity" }),
    createBroker: () => { throw new Error("must not compose broker"); },
  });

  assert.equal(code, 2);
  assert.equal(stdout.value(), "");
  assert.equal(stderr.value(), "ORCHESTRA_DELEGATION_CLI_TARGET_UNAVAILABLE\n");
});
