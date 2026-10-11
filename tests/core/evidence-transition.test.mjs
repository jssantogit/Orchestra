import test from "node:test";
import assert from "node:assert/strict";

import { advanceEvidence } from "../../core/state-machine/evidence-transition.mjs";

const candidate = Object.freeze({
  schema: "orchestra.candidate.v1",
  taskId: "task-1",
  candidateId: "candidate-3",
  generation: 3,
  workspaceId: "primary",
  headSha: "def456",
});

function evidence(overrides = {}) {
  return {
    schema: "orchestra.evidence.v1",
    taskId: "task-1",
    candidateId: "candidate-3",
    candidateGeneration: 3,
    kind: "FOCUSED_TEST",
    status: "PASSED",
    source: { provider: "local", reference: "test:focused" },
    ...overrides,
  };
}

test("successful factual evidence appends to the candidate-bound evidence state", () => {
  const next = advanceEvidence([], { candidate, evidence: evidence(), toolSucceeded: true });
  assert.equal(next.length, 1);
  assert.deepEqual(next[0], evidence());
});

test("failed tool output cannot be promoted into evidence", () => {
  assert.throws(
    () => advanceEvidence([], { candidate, evidence: evidence(), toolSucceeded: false }),
    /FAILED_TOOL_NOT_EVIDENCE/,
  );
});

test("factual failed validation remains evidence while stale generations fail closed", () => {
  const failedValidation = evidence({ status: "FAILED" });
  assert.deepEqual(advanceEvidence([], { candidate, evidence: failedValidation, toolSucceeded: true }), [failedValidation]);
  assert.throws(
    () => advanceEvidence([], { candidate, evidence: evidence({ candidateGeneration: 2 }), toolSucceeded: true }),
    /STALE_EVIDENCE_GENERATION/,
  );
});
