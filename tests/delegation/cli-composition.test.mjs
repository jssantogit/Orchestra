import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDelegationCli } from "../../runtime/delegation/cli.mjs";

function canonicalRequest(targetProvider) {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: `cli-${targetProvider}`,
    taskId: "cli-composition-task",
    source: { provider: targetProvider === "codex" ? "antigravity" : "codex", actorIdHash: "sha256:control" },
    target: { provider: targetProvider, logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "cli-composition-task",
      candidateGeneration: 2,
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

function resultFor(request) {
  return {
    schema: "orchestra.delegation-result.v1",
    delegationId: request.delegationId,
    provider: request.target.provider,
    logicalRole: request.target.logicalRole,
    purpose: request.purpose,
    status: "COMPLETED",
    summary: "review completed",
    findings: [],
    evidenceRefs: [],
    execution: { exitCode: 0, durationMs: 1 },
    workspace: { initialFingerprint: "sha256:a", finalFingerprint: "sha256:a", dirty: false },
  };
}

function capture() {
  let value = "";
  return { write(chunk) { value += String(chunk); }, value() { return value; } };
}

for (const targetProvider of ["antigravity", "codex"]) {
  test(`neutral CLI composes both executors and dispatches ${targetProvider} by canonical target`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-cli-compose-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const candidate = canonicalRequest(targetProvider);
    const requestPath = join(root, "request.json");
    writeFileSync(requestPath, `${JSON.stringify(candidate)}\n`, "utf8");
    const stdout = capture();
    const stderr = capture();
    let providers = null;

    const code = await runDelegationCli({
      argv: ["--request", requestPath, "--repo-root", root, "--generation", "2"],
      stdout,
      stderr,
      createExecutors: () => [
        { provider: "antigravity" },
        { provider: "codex" },
      ],
      createBroker: ({ executors }) => {
        providers = executors.map((executor) => executor.provider);
        return { async executeDelegation(request) { return resultFor(request); } };
      },
    });

    assert.equal(code, 0);
    assert.equal(stderr.value(), "");
    assert.deepEqual(providers, ["antigravity", "codex"]);
    assert.deepEqual(JSON.parse(stdout.value()), resultFor(candidate));
  });
}

test("neutral CLI fails closed when composed executors do not include the requested provider", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-cli-compose-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = canonicalRequest("codex");
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, `${JSON.stringify(candidate)}\n`, "utf8");
  const stdout = capture();
  const stderr = capture();

  const code = await runDelegationCli({
    argv: ["--request", requestPath, "--repo-root", root, "--generation", "2"],
    stdout,
    stderr,
    createExecutors: () => [{ provider: "antigravity" }],
    createBroker: () => { throw new Error("broker must not be created"); },
  });

  assert.equal(code, 2);
  assert.equal(stdout.value(), "");
  assert.equal(stderr.value(), "ORCHESTRA_DELEGATION_CLI_TARGET_UNAVAILABLE\n");
});
