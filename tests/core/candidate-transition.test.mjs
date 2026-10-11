import test from "node:test";
import assert from "node:assert/strict";

import { advanceCandidate } from "../../core/state-machine/candidate-transition.mjs";

const current = Object.freeze({
  schema: "orchestra.candidate.v1",
  taskId: "task-1",
  candidateId: "candidate-2",
  generation: 2,
  workspaceId: "primary",
  headSha: "abc123",
});

function next(overrides = {}) {
  return {
    schema: "orchestra.candidate.v1",
    taskId: "task-1",
    candidateId: "candidate-3",
    generation: 3,
    workspaceId: "primary",
    headSha: "def456",
    ...overrides,
  };
}

test("candidate transition advances exactly one generation within task/workspace lineage", () => {
  assert.deepEqual(advanceCandidate(current, { expectedGeneration: 2, candidate: next() }), next());
});

test("candidate transition rejects stale generation before changing authority", () => {
  assert.throws(
    () => advanceCandidate(current, { expectedGeneration: 1, candidate: next() }),
    /STALE_CANDIDATE_GENERATION/,
  );
});

test("candidate transition rejects lineage changes and generation jumps", () => {
  assert.throws(() => advanceCandidate(current, { expectedGeneration: 2, candidate: next({ taskId: "task-2" }) }), /CANDIDATE_LINEAGE_MISMATCH/);
  assert.throws(() => advanceCandidate(current, { expectedGeneration: 2, candidate: next({ workspaceId: "other" }) }), /CANDIDATE_LINEAGE_MISMATCH/);
  assert.throws(() => advanceCandidate(current, { expectedGeneration: 2, candidate: next({ generation: 4 }) }), /CANDIDATE_GENERATION_INVALID/);
});
