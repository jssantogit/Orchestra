import { validateAuditResult } from '../domain/audit-result.mjs';

function explicitRequirements(packet) {
  const values = [
    packet?.goal,
    packet?.direction?.change,
    ...(Array.isArray(packet?.direction?.preserve) ? packet.direction.preserve : []),
  ];
  return new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()));
}

function candidateMatches(candidate, audit) {
  return Boolean(candidate && audit
    && audit.taskId === candidate.taskId
    && audit.candidateId === candidate.candidateId
    && audit.candidateGeneration === candidate.generation);
}

export function evaluateQuickAuditResult({ packet, candidate, audit, changedFiles = [] } = {}) {
  const schema = validateAuditResult(audit);
  if (!schema.valid) {
    return Object.freeze({ valid: false, verdict: audit?.verdict ?? null, findings: [], reason: 'AUDIT_SCHEMA_INVALID' });
  }
  if (!candidateMatches(candidate, audit)) {
    return Object.freeze({ valid: false, verdict: audit.verdict, findings: [], reason: 'AUDIT_CANDIDATE_MISMATCH' });
  }

  if (audit.verdict === 'PASS') {
    if (audit.findings.length !== 0) {
      return Object.freeze({ valid: false, verdict: audit.verdict, findings: [], reason: 'AUDIT_PASS_HAS_FINDINGS' });
    }
    return Object.freeze({ valid: true, verdict: 'PASS', findings: [], reason: 'AUDIT_PASS' });
  }

  if (audit.findings.length === 0) {
    return Object.freeze({ valid: false, verdict: audit.verdict, findings: [], reason: 'AUDIT_FINDING_MISSING' });
  }

  const changed = new Set((Array.isArray(changedFiles) ? changedFiles : []).filter(Boolean));
  const requirements = explicitRequirements(packet);
  const withinScope = audit.findings.every((finding) => (
    changed.has(finding.location.path) || requirements.has(finding.packetRequirement)
  ));

  if (!withinScope) {
    return Object.freeze({ valid: false, verdict: audit.verdict, findings: [], reason: 'AUDIT_SCOPE_VIOLATION' });
  }

  return Object.freeze({
    valid: true,
    verdict: 'BLOCKING_FINDING',
    findings: audit.findings.map((finding) => ({ ...finding, location: { ...finding.location } })),
    reason: 'AUDIT_BLOCKING_FINDING',
  });
}
