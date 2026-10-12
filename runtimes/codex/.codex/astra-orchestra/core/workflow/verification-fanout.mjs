export const VERIFICATION_BRANCHES = Object.freeze({
  EVIDENCE: 'EVIDENCE',
  QUICK_AUDIT: 'QUICK_AUDIT',
});

export function planVerificationFanout({
  candidate,
  requiredEvidence = [],
  auditRequired = true,
} = {}) {
  if (!candidate || typeof candidate !== 'object' || !candidate.candidateId) {
    throw new Error('DIRECT_WORK_CANDIDATE_REQUIRED');
  }

  const parallel = [];
  if (Array.isArray(requiredEvidence) && requiredEvidence.length > 0) {
    parallel.push(VERIFICATION_BRANCHES.EVIDENCE);
  }
  if (auditRequired === true) parallel.push(VERIFICATION_BRANCHES.QUICK_AUDIT);

  return Object.freeze({
    parallel: Object.freeze([...parallel]),
    acceptanceWaitsFor: Object.freeze([...parallel]),
  });
}
