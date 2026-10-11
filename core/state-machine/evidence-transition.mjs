import { assertCandidate } from "../domain/candidate.mjs";
import { assertEvidence } from "../domain/evidence.mjs";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function sameEvidence(left, right) {
  return left.taskId === right.taskId
    && left.candidateId === right.candidateId
    && left.candidateGeneration === right.candidateGeneration
    && left.kind === right.kind
    && left.source?.provider === right.source?.provider
    && left.source?.reference === right.source?.reference;
}

export function advanceEvidence(current = [], event = {}) {
  if (!Array.isArray(current)) fail("EVIDENCE_STATE_INVALID");
  const candidate = event?.candidate;
  const record = event?.evidence;
  assertCandidate(candidate);
  assertEvidence(record);

  if (event?.toolSucceeded === false) fail("FAILED_TOOL_NOT_EVIDENCE");
  if (
    record.taskId !== candidate.taskId
    || record.candidateId !== candidate.candidateId
    || record.candidateGeneration !== candidate.generation
  ) {
    fail("STALE_EVIDENCE_GENERATION");
  }

  const prior = current.map((item) => {
    assertEvidence(item);
    return item;
  });
  const next = prior.filter((item) => !sameEvidence(item, record));
  next.push(Object.freeze({
    ...record,
    source: Object.freeze({ ...record.source }),
  }));
  return Object.freeze(next);
}
