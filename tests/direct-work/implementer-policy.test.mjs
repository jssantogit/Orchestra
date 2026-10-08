import test from "node:test";
import assert from "node:assert/strict";

import { buildImplementationPacket } from "../../core/workflow/implementation-packet.mjs";
import { authorizeTestMutation } from "../../core/policy/test-mutation.mjs";
import {
  IMPLEMENTATION_ACTIONS,
  nextImplementationAction,
  createFailureReturn,
} from "../../core/workflow/implementation-result.mjs";

function packet(tests = "READ_ONLY") {
  return buildImplementationPacket({
    taskId: "dw-3",
    candidateGeneration: 2,
    goal: "Fix formatter precision.",
    direction: {
      cause: "formatNumber rounds before requested precision is applied",
      change: "apply requested precision before final formatting",
      preserve: ["locale separator behavior"],
    },
    anchors: [{ path: "src/formatter.js", symbol: "formatNumber", testHint: "precision regression" }],
    scope: {
      allowedAreas: ["src/formatter.js", "test/formatter.test.js"],
      forbidden: ["test/parser.test.js"],
    },
    permissions: { discovery: "DIRECTED", tests, sideEffects: [] },
    validation: ["node --test test/formatter.test.js"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  });
}

test("READ_ONLY packet denies all test mutations", () => {
  assert.deepEqual(authorizeTestMutation({
    packet: packet("READ_ONLY"),
    testPath: "test/formatter.test.js",
    changeKind: "REGRESSION_TEST",
  }), { allowed: false, reason: "TEST_MUTATION_READ_ONLY" });
});

test("missing test-mutation capability fails closed", () => {
  const base = packet("READ_ONLY");
  const noTestCapability = {
    ...base,
    permissions: { discovery: base.permissions.discovery, sideEffects: [] },
  };
  assert.deepEqual(authorizeTestMutation({
    packet: noTestCapability,
    testPath: "test/formatter.test.js",
    changeKind: "REGRESSION_TEST",
  }), { allowed: false, reason: "TEST_MUTATION_READ_ONLY" });
});

test("authorized regression target is allowed but unrelated rewrites are denied", () => {
  const mutable = packet("MODIFY_AUTHORIZED_TARGETS");
  assert.deepEqual(authorizeTestMutation({
    packet: mutable,
    testPath: "test/formatter.test.js",
    changeKind: "REGRESSION_TEST",
  }), { allowed: true, reason: "AUTHORIZED_REGRESSION_TARGET" });

  assert.deepEqual(authorizeTestMutation({
    packet: mutable,
    testPath: "test/formatter.test.js",
    changeKind: "UNRELATED_REWRITE",
  }), { allowed: false, reason: "TEST_CHANGE_NOT_AUTHORIZED" });

  assert.deepEqual(authorizeTestMutation({
    packet: mutable,
    testPath: "test/unrelated.test.js",
    changeKind: "REGRESSION_TEST",
  }), { allowed: false, reason: "TEST_TARGET_NOT_AUTHORIZED" });
});

test("only SELF_CAUSED failures may be repaired by the implementer", () => {
  assert.equal(nextImplementationAction({ failureRelation: "SELF_CAUSED" }), IMPLEMENTATION_ACTIONS.REPAIR);
  assert.equal(nextImplementationAction({ failureRelation: "UNRELATED" }), IMPLEMENTATION_ACTIONS.RETURN_TO_CONTROL);
  assert.equal(nextImplementationAction({ failureRelation: "UNCERTAIN" }), IMPLEMENTATION_ACTIONS.RETURN_TO_CONTROL);
  assert.equal(nextImplementationAction({ failureRelation: "UNKNOWN" }), IMPLEMENTATION_ACTIONS.RETURN_TO_CONTROL);
});

test("failure return preserves factual boundary and never asks the implementer to investigate", () => {
  const candidate = {
    schema: "orchestra.candidate.v1",
    taskId: "dw-3",
    generation: 2,
    identity: "candidate-2",
    changedPaths: ["src/formatter.js"],
  };
  const returned = createFailureReturn({
    command: "node --test test/formatter.test.js",
    evidenceRef: ".agents/artifacts/failure-17.json",
    boundary: "UNCERTAIN",
    candidate,
  });

  assert.deepEqual(returned, {
    type: "IMPLEMENTATION_FAILURE_RETURN",
    action: "RETURN_TO_CONTROL",
    command: "node --test test/formatter.test.js",
    evidenceRef: ".agents/artifacts/failure-17.json",
    boundary: "UNCERTAIN",
    candidate,
  });
  assert.equal("discovery" in returned, false);
  assert.equal("repair" in returned, false);
});
