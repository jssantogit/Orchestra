import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDelegationCli } from "../../runtime/delegation/cli.mjs";

function request() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "recursive-cli-delegation",
    taskId: "recursive-cli-task",
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "recursive-cli-task",
      candidateGeneration: 1,
      goal: "review candidate",
      direction: { change: "inspect", preserve: [] },
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

function capture() {
  let value = "";
  return { write(chunk) { value += String(chunk); }, value() { return value; } };
}

test("source CLI refuses execution from an already delegated worker context", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-recursion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, `${JSON.stringify(request())}\n`, "utf8");

  let brokerCreated = false;
  const stdout = capture();
  const stderr = capture();
  const code = await runDelegationCli({
    argv: ["--request", requestPath, "--repo-root", root, "--generation", "1"],
    stdout,
    stderr,
    env: {
      ORCHESTRA_DELEGATION_ACTIVE: "1",
      ORCHESTRA_DELEGATION_DEPTH: "1",
    },
    createExecutor: () => ({ provider: "antigravity" }),
    createBroker: () => {
      brokerCreated = true;
      return { async executeDelegation() { throw new Error("must not execute"); } };
    },
  });

  assert.equal(code, 2);
  assert.equal(stdout.value(), "");
  assert.equal(stderr.value(), "ORCHESTRA_DELEGATION_CLI_RECURSION_DENIED\n");
  assert.equal(brokerCreated, false);
});
