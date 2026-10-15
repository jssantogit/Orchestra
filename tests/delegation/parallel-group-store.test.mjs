import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createParallelGroup,
  readParallelGroup,
  recordParallelGroupCleanup,
  transitionParallelGroupState,
} from "../../runtime/delegation/parallel-group-store.mjs";

function packet({ taskId = "parallel-task", generation = 7, area = "src/a/**" } = {}) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId,
    candidateGeneration: generation,
    goal: "implement one bounded parallel shard",
    direction: { change: "modify only the assigned shard", preserve: ["public API"] },
    anchors: [{ file: area.replace(/\/\*\*$/, "/entry.mjs") }],
    scope: { allowedAreas: [area], forbidden: ["secrets/**"] },
    permissions: {
      discovery: "DIRECTED",
      tests: "MODIFY_AUTHORIZED_TARGETS",
      sideEffects: ["LOCAL_TEST"],
    },
    validation: ["focused tests"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function group(groupId = "parallel-group-1") {
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId,
    taskId: "parallel-task",
    generation: 7,
    source: { provider: "codex", actorIdHash: "sha256:source-actor" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source-fingerprint",
    canonicalGitFingerprint: "sha256:git-fingerprint",
    members: [
      {
        memberId: "local",
        targetProvider: "codex",
        packet: packet({ area: "src/a/**" }),
        mutationScope: { allowedPaths: ["src/a/**"], forbiddenPaths: ["secrets/**"] },
      },
      {
        memberId: "external",
        targetProvider: "antigravity",
        packet: packet({ area: "src/b/**" }),
        mutationScope: { allowedPaths: ["src/b/**"], forbiddenPaths: ["secrets/**"] },
      },
    ],
  };
}

function withRoot(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("parallel group store creates one bounded CREATED record atomically", () => withRoot(
  "orchestra-parallel-group-store-",
  (root) => {
    const created = createParallelGroup(root, group());
    assert.equal(created.state, "CREATED");
    assert.equal(created.group.groupId, "parallel-group-1");
    assert.deepEqual(created.memberArtifactIds, []);
    assert.equal(created.compositeArtifactId, null);
    assert.equal(created.failureReason, null);
    assert.deepEqual(created.cleanupFailures, []);

    const read = readParallelGroup(root, "parallel-group-1");
    assert.equal(read.exists, true);
    assert.equal(read.valid, true);
    assert.equal(read.record.state, "CREATED");
    assert.equal(read.record.group.members.length, 2);

    assert.throws(() => createParallelGroup(root, group()), /PARALLEL_GROUP_ALREADY_EXISTS/);
  },
));

test("parallel group store rejects unsafe IDs and malformed persisted state", () => withRoot(
  "orchestra-parallel-group-invalid-",
  (root) => {
    for (const id of ["", ".", "..", "../escape", "a/b", "a\\b"]) {
      assert.throws(() => readParallelGroup(root, id), /PARALLEL_GROUP_ID_INVALID/);
    }

    const created = createParallelGroup(root, group("parallel-malformed"));
    const statePath = join(root, ".orchestra", "state", "delegation", "parallel-groups", "parallel-malformed", "group.json");
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    persisted.prompt = "forbidden raw model channel";
    writeFileSync(statePath, `${JSON.stringify(persisted)}\n`, "utf8");

    const read = readParallelGroup(root, created.group.groupId);
    assert.equal(read.exists, true);
    assert.equal(read.valid, false);
    assert.equal(read.reason, "PARALLEL_GROUP_STATE_INVALID");
  },
));

test("parallel group lifecycle allows only the exact forward transition graph", () => withRoot(
  "orchestra-parallel-group-transitions-",
  (root) => {
    createParallelGroup(root, group());
    const steps = [
      ["CREATED", "RUNNING", {}],
      ["RUNNING", "MEMBERS_READY", { memberArtifactIds: ["artifact-local", "artifact-external"] }],
      ["MEMBERS_READY", "COMPOSING", {}],
      ["COMPOSING", "READY_FOR_REVIEW", { compositeArtifactId: "composite-one" }],
      ["READY_FOR_REVIEW", "PROMOTED", {}],
    ];

    for (const [expectedState, nextState, facts] of steps) {
      const result = transitionParallelGroupState(root, "parallel-group-1", {
        expectedState,
        nextState,
        ...facts,
      });
      assert.equal(result.transitioned, true, `${expectedState} -> ${nextState}`);
      assert.equal(result.record.state, nextState);
    }

    const terminal = transitionParallelGroupState(root, "parallel-group-1", {
      expectedState: "PROMOTED",
      nextState: "DISCARDED",
    });
    assert.equal(terminal.transitioned, false);
    assert.equal(terminal.reason, "PARALLEL_GROUP_TRANSITION_INVALID");
    assert.equal(readParallelGroup(root, "parallel-group-1").record.state, "PROMOTED");
  },
));

test("parallel group may fail before terminal review completion and FAILED stays terminal", () => withRoot(
  "orchestra-parallel-group-failed-",
  (root) => {
    createParallelGroup(root, group());
    assert.equal(transitionParallelGroupState(root, "parallel-group-1", {
      expectedState: "CREATED",
      nextState: "RUNNING",
    }).transitioned, true);
    const failed = transitionParallelGroupState(root, "parallel-group-1", {
      expectedState: "RUNNING",
      nextState: "FAILED",
      failureReason: "PROVIDER_UNAVAILABLE",
    });
    assert.equal(failed.transitioned, true);
    assert.equal(failed.record.failureReason, "PROVIDER_UNAVAILABLE");

    const invalid = transitionParallelGroupState(root, "parallel-group-1", {
      expectedState: "FAILED",
      nextState: "RUNNING",
    });
    assert.deepEqual(
      { transitioned: invalid.transitioned, reason: invalid.reason },
      { transitioned: false, reason: "PARALLEL_GROUP_TRANSITION_INVALID" },
    );
  },
));

test("terminal group cleanup state persists only bounded member recovery paths", () => withRoot(
  "orchestra-parallel-group-cleanup-",
  (root) => {
    createParallelGroup(root, group());
    transitionParallelGroupState(root, "parallel-group-1", {
      expectedState: "CREATED",
      nextState: "FAILED",
      failureReason: "EXECUTION_FAILED",
    });

    const updated = recordParallelGroupCleanup(root, "parallel-group-1", [
      { memberId: "local", recoverablePath: "/tmp/orchestra-parallel-local/workspace" },
    ]);
    assert.equal(updated.updated, true);
    assert.deepEqual(updated.record.cleanupFailures, [
      { memberId: "local", recoverablePath: "/tmp/orchestra-parallel-local/workspace" },
    ]);

    assert.throws(
      () => recordParallelGroupCleanup(root, "parallel-group-1", [
        { memberId: "local", recoverablePath: "/tmp/x", stderr: "raw provider output" },
      ]),
      /PARALLEL_GROUP_CLEANUP_INVALID/,
    );
  },
));
