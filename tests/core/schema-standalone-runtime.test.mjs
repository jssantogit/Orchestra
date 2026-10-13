import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const schemaRoot = join(repoRoot, "core", "schema");

const validPacket = {
  schema: "orchestra.implementation-packet.v1",
  taskId: "task-standalone",
  candidateGeneration: 0,
  goal: "prove standalone schema validation",
  direction: { change: "validate without repository dependencies", preserve: [] },
  anchors: [{ symbol: "validateSchema" }],
  scope: { allowedAreas: ["core/schema/**"], forbidden: [] },
  permissions: {
    discovery: "DIRECTED",
    tests: "READ_ONLY",
    sideEffects: ["LOCAL_TEST"],
  },
  validation: ["standalone fixture"],
  failurePolicy: {
    selfCaused: "REPAIR",
    unrelatedOrUncertain: "RETURN_TO_CONTROL",
  },
};

const validDelegationRequest = {
  schema: "orchestra.delegation-request.v1",
  delegationId: "delegation-standalone",
  taskId: "task-standalone",
  source: { provider: "provider-a", actorIdHash: "sha256:source" },
  target: { provider: "provider-b", logicalRole: "INVESTIGATOR" },
  purpose: "SECOND_OPINION",
  packet: validPacket,
  authority: {
    capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
    mutation: "FORBIDDEN",
    network: "FORBIDDEN",
    mayDelegate: false,
  },
  workspace: {
    sourceFingerprint: "sha256:workspace",
    sourceRevision: "abcdef1234567890",
    isolation: "EPHEMERAL_WORKTREE",
  },
  limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
};

const validDelegationResult = {
  schema: "orchestra.delegation-result.v1",
  delegationId: "delegation-standalone",
  provider: "provider-b",
  logicalRole: "INVESTIGATOR",
  purpose: "SECOND_OPINION",
  status: "COMPLETED",
  summary: "bounded result",
  findings: [],
  evidenceRefs: [],
  execution: { exitCode: 0, durationMs: 50 },
  workspace: {
    initialFingerprint: "sha256:initial",
    finalFingerprint: "sha256:final",
    dirty: false,
  },
};

test("generated schema validators run in an isolated fixture with no node_modules", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestra-schema-standalone-"));
  const copiedRoot = join(fixture, "core", "schema");

  try {
    await cp(schemaRoot, copiedRoot, { recursive: true });
    const { validateSchema } = await import(`${pathToFileURL(join(copiedRoot, "validator.mjs")).href}?fixture=${Date.now()}`);

    const valid = validateSchema("implementation-packet.v1.schema.json", validPacket);
    assert.equal(valid.valid, true, JSON.stringify(valid.errors));

    const invalid = validateSchema("implementation-packet.v1.schema.json", { ...validPacket, transcript: "forbidden" });
    assert.equal(invalid.valid, false);

    assert.equal(validateSchema("delegation-request.v1.schema.json", validDelegationRequest).valid, true);
    assert.equal(validateSchema("delegation-result.v1.schema.json", validDelegationResult).valid, true);

    const recursive = structuredClone(validDelegationRequest);
    recursive.authority.mayDelegate = true;
    assert.equal(validateSchema("delegation-request.v1.schema.json", recursive).valid, false);

    const rawResult = { ...validDelegationResult, transcript: "forbidden" };
    assert.equal(validateSchema("delegation-result.v1.schema.json", rawResult).valid, false);

    const validEvent = {
      schema: "orchestra.runtime-event.v1",
      eventId: "event-standalone",
      type: "CANDIDATE_READY",
      generation: 1,
      taskId: "task-standalone",
      actor: { provider: "codex", sessionIdHash: "sha256:abc123" },
      payload: {},
    };
    assert.equal(validateSchema("runtime-event.v1.schema.json", validEvent).valid, true);

    for (const field of ["session_id", "conversationId", "transcript", "reasoning", "stdout", "unknownPayloadField"]) {
      const event = { ...validEvent, payload: { [field]: "must not become canonical domain state" } };
      assert.equal(validateSchema("runtime-event.v1.schema.json", event).valid, false, `payload.${field} must be rejected`);
    }

    await assert.rejects(
      import(pathToFileURL(join(fixture, "node_modules", "ajv", "index.js")).href),
      /ERR_MODULE_NOT_FOUND|Cannot find module/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
