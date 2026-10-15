import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDelegationCli } from "../../runtime/delegation/cli.mjs";

function request() {
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: "cli-v2-roundtrip",
    taskId: "cli-v2-task",
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "cli-v2-task",
      candidateGeneration: 4,
      goal: "implement bounded change",
      direction: { change: "edit authorized files", preserve: ["CONTROL authority"] },
      anchors: [{ file: "src/example.mjs" }],
      scope: { allowedAreas: ["src/**"], forbidden: [] },
      permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: ["WORKSPACE_EDIT"] },
      validation: ["focused tests"],
      failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
    },
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
      mutationScope: { allowedPaths: ["src/**"], forbiddenPaths: [] },
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

function completedResult() {
  return {
    schema: "orchestra.delegation-result.v2",
    delegationId: "cli-v2-roundtrip",
    provider: "antigravity",
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    status: "COMPLETED",
    summary: "implementation sealed for review",
    findings: [],
    evidenceRefs: ["test:focused"],
    execution: { exitCode: 0, durationMs: 12 },
    workspace: {
      sourceRevision: "abcdef1234567890",
      sourceFingerprint: "sha256:source",
      delegatedPath: "/tmp/orchestra-retained-clone",
      changedPaths: ["src/example.mjs"],
      dirty: true,
    },
    artifact: {
      artifactId: "cli-v2-roundtrip",
      patchSha256: "sha256:patch",
      mutationDigest: "sha256:mutation",
      changedPaths: ["src/example.mjs"],
      state: "READY_FOR_REVIEW",
    },
  };
}

test("delegation CLI preserves v2 request/result identity and returns CONTROL context without promotion", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "orchestra-cli-v2-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const requestPath = join(scratch, "request.json");
  writeFileSync(requestPath, `${JSON.stringify(request())}\n`, "utf8");

  let brokerInput = null;
  let brokerContext = null;
  const result = await runDelegationCli([
    "--request", requestPath,
    "--repo-root", scratch,
    "--generation", "4",
  ], {
    createExecutors: () => [],
    createBroker: () => ({
      async executeDelegation(input, context) {
        brokerInput = input;
        brokerContext = context;
        return completedResult();
      },
    }),
  });

  assert.equal(brokerInput.schema, "orchestra.delegation-request.v2");
  assert.equal(brokerInput.delegationId, "cli-v2-roundtrip");
  assert.equal(brokerContext.generation, 4);
  assert.deepEqual(brokerContext.actor, {
    provider: "codex",
    actorIdHash: "sha256:control",
    actorKind: "ROOT",
    isRoot: true,
  });
  assert.deepEqual(result, completedResult());
  assert.equal(result.artifact.state, "READY_FOR_REVIEW");
  assert.equal("accepted" in result, false);
  assert.equal("candidate" in result, false);
  assert.equal("evidence" in result, false);
});
