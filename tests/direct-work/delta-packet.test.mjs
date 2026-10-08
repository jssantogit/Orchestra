import test from "node:test";
import assert from "node:assert/strict";

import { buildImplementationPacket } from "../../core/workflow/implementation-packet.mjs";
import {
  createDeltaPacket,
  validateDeltaPacket,
} from "../../core/workflow/delta-packet.mjs";

function originalPacket(discovery = "DIRECTED") {
  return buildImplementationPacket({
    taskId: "dw-3",
    candidateGeneration: 2,
    goal: "Fix formatter precision.",
    direction: {
      cause: "formatNumber rounds before requested precision is applied",
      change: "apply requested precision before final formatting",
      preserve: ["locale separator behavior", "negative number behavior"],
    },
    anchors: [{ path: "src/formatter.js", symbol: "formatNumber", testHint: "precision regression" }],
    scope: {
      allowedAreas: ["src/formatter.js", "test/formatter.test.js"],
      forbidden: [],
    },
    permissions: { discovery, tests: "READ_ONLY", sideEffects: [] },
    validation: ["node --test test/formatter.test.js"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  });
}

const candidate = Object.freeze({
  schema: "orchestra.candidate.v1",
  taskId: "dw-3",
  generation: 2,
  identity: "candidate-2",
  changedPaths: ["src/formatter.js"],
});

test("Delta Packet retains task lineage/direction and increments generation", () => {
  const original = originalPacket();
  const delta = createDeltaPacket({
    originalPacket: original,
    candidate,
    confirmedFinding: {
      statement: "precision=0 regressed for negative values",
      evidenceRef: ".agents/artifacts/test-failure.json",
    },
    correctionArea: {
      allowedAreas: ["src/formatter.js"],
      statement: "correct zero-precision handling only",
    },
    revalidation: ["node --test test/formatter.test.js"],
  });

  assert.equal(delta.schema, "orchestra.delta-packet.v1");
  assert.equal(delta.taskId, original.taskId);
  assert.equal(delta.parentCandidateIdentity, candidate.identity);
  assert.equal(delta.baseCandidateGeneration, 2);
  assert.equal(delta.candidateGeneration, 3);
  assert.deepEqual(delta.direction, original.direction);
  assert.notEqual(delta.direction, original.direction);
  assert.equal(delta.discovery, "DIRECTED");
  assert.deepEqual(validateDeltaPacket(delta), { valid: true, errors: [] });
});

test("Delta Packet contains exactly one confirmed finding and one correction area", () => {
  const delta = createDeltaPacket({
    originalPacket: originalPacket(),
    candidate,
    confirmedFinding: {
      statement: "precision=0 regressed",
      evidenceRef: "artifact://failure",
    },
    correctionArea: {
      allowedAreas: ["src/formatter.js"],
      statement: "fix zero precision branch",
    },
    revalidation: ["node --test test/formatter.test.js"],
  });

  assert.deepEqual(delta.confirmedFinding, {
    statement: "precision=0 regressed",
    evidenceRef: "artifact://failure",
  });
  assert.deepEqual(delta.correctionArea, {
    allowedAreas: ["src/formatter.js"],
    statement: "fix zero precision branch",
  });
  assert.equal(Array.isArray(delta.confirmedFinding), false);
  assert.equal(Array.isArray(delta.correctionArea), false);
});

test("Delta Packet cannot grant INVESTIGATIVE discovery", () => {
  const delta = createDeltaPacket({
    originalPacket: originalPacket("INVESTIGATIVE"),
    candidate,
    confirmedFinding: {
      statement: "confirmed local regression",
      evidenceRef: "artifact://failure",
    },
    correctionArea: {
      allowedAreas: ["src/formatter.js"],
      statement: "repair confirmed local regression",
    },
    revalidation: ["node --test test/formatter.test.js"],
  });

  assert.equal(delta.discovery, "DIRECTED");
  assert.equal(validateDeltaPacket({ ...delta, discovery: "INVESTIGATIVE" }).valid, false);
});

test("Delta Packet rejects stale or cross-task candidate lineage", () => {
  assert.throws(() => createDeltaPacket({
    originalPacket: originalPacket(),
    candidate: { ...candidate, taskId: "other-task" },
    confirmedFinding: { statement: "failure", evidenceRef: "artifact://failure" },
    correctionArea: { allowedAreas: ["src/formatter.js"], statement: "repair" },
    revalidation: ["node --test test/formatter.test.js"],
  }), /candidate lineage/i);

  assert.throws(() => createDeltaPacket({
    originalPacket: originalPacket(),
    candidate: { ...candidate, generation: 1 },
    confirmedFinding: { statement: "failure", evidenceRef: "artifact://failure" },
    correctionArea: { allowedAreas: ["src/formatter.js"], statement: "repair" },
    revalidation: ["node --test test/formatter.test.js"],
  }), /candidate lineage/i);
});
