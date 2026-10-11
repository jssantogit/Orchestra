import { validateAuditResult } from '../domain/audit-result.mjs';
import { validateCandidate } from '../domain/candidate.mjs';
import { validateEvidence } from '../domain/evidence.mjs';

function reject(reason) {
  return Object.freeze({ accepted: false, reason });
}

function boundToCandidate(record, candidate) {
  return record.taskId === candidate.taskId
    && record.candidateId === candidate.candidateId
    && record.candidateGeneration === candidate.generation;
}

export function evaluateDirectWorkAcceptance({
  packet,
  candidate,
  evidence = [],
  audit = null,
  auditRequired = true,
  currentGeneration,
} = {}) {
  if (!validateCandidate(candidate).valid) return reject('CANDIDATE_SCHEMA_INVALID');
  if (packet?.taskId !== candidate.taskId || packet?.candidateGeneration !== candidate.generation) {
    return reject('PACKET_CANDIDATE_MISMATCH');
  }
  if (currentGeneration !== candidate.generation) return reject('STALE_CANDIDATE_GENERATION');
  if (!Array.isArray(evidence)) return reject('EVIDENCE_SCHEMA_INVALID');

  for (const record of evidence) {
    if (!validateEvidence(record).valid) return reject('EVIDENCE_SCHEMA_INVALID');
    if (!boundToCandidate(record, candidate)) return reject('STALE_EVIDENCE_GENERATION');
  }

  const requiredKinds = Array.isArray(packet?.validation) ? packet.validation : [];
  for (const kind of requiredKinds) {
    const record = evidence.find((item) => item.kind === kind);
    if (!record || record.status !== 'PASSED') return reject('REQUIRED_EVIDENCE_NOT_PASSED');
  }

  if (auditRequired) {
    if (!audit) return reject('AUDIT_REQUIRED');
    if (!validateAuditResult(audit).valid) return reject('AUDIT_SCHEMA_INVALID');
    if (!boundToCandidate(audit, candidate)) return reject('STALE_AUDIT_GENERATION');
    if (audit.verdict !== 'PASS' || audit.findings.length !== 0) return reject('AUDIT_NOT_PASSING');
  }

  return Object.freeze({ accepted: true, reason: 'ACCEPTED' });
}
