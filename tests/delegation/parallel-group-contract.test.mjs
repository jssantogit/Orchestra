import test from "node:test";
import assert from "node:assert/strict";

import { validateSchema } from "../../core/schema/validator.mjs";

function packet({ taskId = "parallel-task", generation = 7, area = "src/a/**" } = {}) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId,
    candidateGeneration: generation,
    goal: "implement one bounded parallel shard",
    direction: {
      change: "modify only the assigned shard",
      preserve: ["public API"],
    },
    anchors: [{ file: area.replace(/\/\*\*$/, "/entry.mjs") }],
    scope: {
      allowedAreas: [area],
      forbidden: ["secrets/**"],
    },
    permissions: {
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
      sideEffects: ["LOCAL_TEST"],
    },
    validation: ["focused tests"],
    failurePolicy: {
      selfCaused: "REPAIR",
      unrelatedOrUncertain: "RETURN_TO_CONTROL",
    },
  };
}

function member({ memberId, targetProvider, area }) {
  return {
    memberId,
    targetProvider,
    packet: packet({ area }),
    mutationScope: {
      allowedPaths: [area],
      forbiddenPaths: ["secrets/**"],
    },
  };
}

function group(overrides = {}) {
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: "parallel-group-1",
    taskId: "parallel-task",
    generation: 7,
    source: {
      provider: "codex",
      actorIdHash: "sha256:source-actor",
    },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source-fingerprint",
    canonicalGitFingerprint: "sha256:git-fingerprint",
    members: [
      member({ memberId: "local", targetProvider: "codex", area: "src/a/**" }),
      member({ memberId: "external", targetProvider: "antigravity", area: "src/b/**" }),
    ],
    ...overrides,
  };
}

function validate(value) {
  return validateSchema("parallel-implementation-group.v1.schema.json", value);
}

test("parallel implementation group schema accepts exactly two bounded implementation members", () => {
  const result = validate(group());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("parallel implementation group schema rejects cardinality, duplicate identities, and unknown fields", () => {
  const valid = group();
  const cases = [
    { ...valid, members: [valid.members[0]] },
    { ...valid, members: [...valid.members, member({ memberId: "third", targetProvider: "other", area: "src/c/**" })] },
    { ...valid, members: [{ ...valid.members[0] }, { ...valid.members[1], memberId: valid.members[0].memberId }] },
    { ...valid, members: [{ ...valid.members[0] }, { ...valid.members[1], targetProvider: valid.members[0].targetProvider }] },
    { ...valid, unexpected: true },
  ];

  for (const value of cases) assert.equal(validate(value).valid, false);
});

test("parallel implementation group domain enforces shared task and generation facts", async () => {
  let domain;
  try {
    domain = await import("../../core/domain/parallel-implementation.mjs");
  } catch (error) {
    assert.fail(`parallel implementation domain module is required: ${error.code || error.message}`);
  }

  assert.equal(domain.validateParallelImplementationGroup(group()).valid, true);

  const wrongTask = group();
  wrongTask.members[1] = {
    ...wrongTask.members[1],
    packet: packet({ taskId: "other-task", generation: 7, area: "src/b/**" }),
  };
  assert.equal(domain.validateParallelImplementationGroup(wrongTask).valid, false);

  const wrongGeneration = group();
  wrongGeneration.members[1] = {
    ...wrongGeneration.members[1],
    packet: packet({ taskId: "parallel-task", generation: 8, area: "src/b/**" }),
  };
  assert.equal(domain.validateParallelImplementationGroup(wrongGeneration).valid, false);
});

test("parallel implementation group domain accepts a same-provider member but requires two distinct target providers", async () => {
  let domain;
  try {
    domain = await import("../../core/domain/parallel-implementation.mjs");
  } catch (error) {
    assert.fail(`parallel implementation domain module is required: ${error.code || error.message}`);
  }

  assert.equal(domain.validateParallelImplementationGroup(group()).valid, true);

  const duplicateProvider = group();
  duplicateProvider.members[1] = {
    ...duplicateProvider.members[1],
    targetProvider: "codex",
  };
  assert.equal(domain.validateParallelImplementationGroup(duplicateProvider).valid, false);
});
