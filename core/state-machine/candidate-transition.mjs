import { assertCandidate } from "../domain/candidate.mjs";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function advanceCandidate(current, event = {}) {
  assertCandidate(current);
  const expectedGeneration = event?.expectedGeneration;
  if (!Number.isInteger(expectedGeneration) || expectedGeneration !== current.generation) {
    fail("STALE_CANDIDATE_GENERATION");
  }

  const next = event?.candidate;
  assertCandidate(next);
  if (next.taskId !== current.taskId || next.workspaceId !== current.workspaceId) {
    fail("CANDIDATE_LINEAGE_MISMATCH");
  }
  if (next.generation !== current.generation + 1) {
    fail("CANDIDATE_GENERATION_INVALID");
  }

  return Object.freeze({
    schema: next.schema,
    taskId: next.taskId,
    candidateId: next.candidateId,
    generation: next.generation,
    workspaceId: next.workspaceId,
    headSha: next.headSha,
  });
}
