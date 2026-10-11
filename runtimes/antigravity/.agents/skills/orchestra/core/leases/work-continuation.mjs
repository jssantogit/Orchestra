import { validateAuditResult } from "../domain/audit-result.mjs";
import { validateCandidate } from "../domain/candidate.mjs";
import { validateEvidence } from "../domain/evidence.mjs";
import { validateWorkLease } from "../domain/work-lease.mjs";

const SCHEMA = "orchestra.work-continuation.v1";
const TERMINAL_LEASE_STATES = new Set(["DONE", "BLOCKED"]);

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function clean(value, max = 2000) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function safeTask(task = {}) {
  return Object.freeze({
    taskId: clean(task.taskId, 300),
    state: clean(task.state, 80) || null,
    action: clean(task.action, 120) || null,
    domain: clean(task.domain, 120) || null,
    implementationDirection: clean(task.implementationDirection, 2000) || null,
  });
}

function safeCandidate(candidate) {
  return Object.freeze({
    taskId: candidate.taskId,
    candidateId: candidate.candidateId,
    generation: candidate.generation,
    workspaceId: candidate.workspaceId,
    headSha: candidate.headSha,
  });
}

function safeEvidence(record) {
  return Object.freeze({
    taskId: record.taskId,
    candidateId: record.candidateId,
    candidateGeneration: record.candidateGeneration,
    kind: record.kind,
    status: record.status,
    source: Object.freeze({
      provider: record.source.provider,
      reference: record.source.reference,
    }),
  });
}

function safeAudit(audit) {
  if (!audit) return null;
  return Object.freeze({
    taskId: audit.taskId,
    candidateId: audit.candidateId,
    candidateGeneration: audit.candidateGeneration,
    verdict: audit.verdict,
    findings: Object.freeze(audit.findings.map((finding) => Object.freeze({
      location: Object.freeze({
        path: finding.location.path,
        ...(Number.isInteger(finding.location.line) ? { line: finding.location.line } : {}),
      }),
      packetRequirement: clean(finding.packetRequirement, 500),
      issue: clean(finding.issue, 1000),
    }))),
  });
}

function safeBlockers(blockers = []) {
  if (!Array.isArray(blockers)) return Object.freeze([]);
  return Object.freeze(blockers.slice(0, 20).map((blocker) => clean(blocker, 500)).filter(Boolean));
}

function candidateBound(record, candidate) {
  return record.taskId === candidate.taskId
    && record.candidateId === candidate.candidateId
    && record.candidateGeneration === candidate.generation;
}

function safeStatus(continuation, lease) {
  return Object.freeze({
    taskId: continuation?.task?.taskId || lease?.taskId || null,
    state: continuation?.task?.state || lease?.state || null,
    candidateId: continuation?.candidate?.candidateId || lease?.candidate || null,
    candidateGeneration: continuation?.candidate?.generation ?? null,
    leaseGeneration: lease?.generation ?? null,
  });
}

function reject(reason, continuation, lease) {
  return Object.freeze({ valid: false, reason, status: safeStatus(continuation, lease) });
}

function validateCapsuleShape(continuation) {
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) return false;
  const allowed = new Set([
    "schema", "task", "workspaceId", "workspaceFingerprint", "leaseGeneration",
    "candidate", "evidence", "audit", "blockers",
  ]);
  if (Object.keys(continuation).some((key) => !allowed.has(key))) return false;
  if (continuation.schema !== SCHEMA) return false;
  if (!continuation.task || typeof continuation.task !== "object") return false;
  if (!continuation.task.taskId || !continuation.workspaceId || !continuation.workspaceFingerprint) return false;
  if (!Number.isInteger(continuation.leaseGeneration) || continuation.leaseGeneration < 0) return false;
  if (!continuation.candidate || !Array.isArray(continuation.evidence) || !Array.isArray(continuation.blockers)) return false;
  return true;
}

export function buildWorkContinuation({
  task,
  lease,
  candidate,
  evidence = [],
  audit = null,
  blockers = [],
  workspaceFingerprint,
} = {}) {
  if (!validateWorkLease(lease).valid) fail("WORK_CONTINUATION_LEASE_INVALID");
  if (!validateCandidate(candidate).valid) fail("WORK_CONTINUATION_CANDIDATE_INVALID");
  if (!Array.isArray(evidence)) fail("WORK_CONTINUATION_EVIDENCE_INVALID");
  if (audit && !validateAuditResult(audit).valid) fail("WORK_CONTINUATION_AUDIT_INVALID");
  const fingerprint = clean(workspaceFingerprint, 300);
  if (!fingerprint) fail("WORK_CONTINUATION_FINGERPRINT_REQUIRED");

  const taskId = clean(task?.taskId, 300);
  if (!taskId || taskId !== lease.taskId || taskId !== candidate.taskId) {
    fail("WORK_CONTINUATION_TASK_MISMATCH");
  }
  if (candidate.workspaceId !== lease.workspaceId) fail("WORK_CONTINUATION_WORKSPACE_MISMATCH");
  if (lease.candidate && lease.candidate !== candidate.candidateId) fail("WORK_CONTINUATION_CANDIDATE_MISMATCH");

  for (const record of evidence) {
    if (!validateEvidence(record).valid) fail("WORK_CONTINUATION_EVIDENCE_INVALID");
    if (!candidateBound(record, candidate)) fail("WORK_CONTINUATION_EVIDENCE_MISMATCH");
  }
  if (audit && !candidateBound(audit, candidate)) fail("WORK_CONTINUATION_AUDIT_MISMATCH");

  return Object.freeze({
    schema: SCHEMA,
    task: safeTask(task),
    workspaceId: lease.workspaceId,
    workspaceFingerprint: fingerprint,
    leaseGeneration: lease.generation,
    candidate: safeCandidate(candidate),
    evidence: Object.freeze(evidence.map(safeEvidence)),
    audit: safeAudit(audit),
    blockers: safeBlockers(blockers),
  });
}

export function validateContinuationForLease({ continuation, lease, workspaceFingerprint } = {}) {
  if (!validateWorkLease(lease).valid) return reject("WORK_CONTINUATION_LEASE_INVALID", continuation, lease);
  if (!validateCapsuleShape(continuation)) return reject("WORK_CONTINUATION_INVALID", continuation, lease);

  if (!TERMINAL_LEASE_STATES.has(lease.state) && lease.capabilities.includes("WORKSPACE_EDIT")) {
    return reject("WRITE_LEASE_ACTIVE", continuation, lease);
  }

  if (clean(workspaceFingerprint, 300) !== continuation.workspaceFingerprint) {
    return reject("WORKSPACE_FINGERPRINT_MISMATCH", continuation, lease);
  }
  if (continuation.workspaceId !== lease.workspaceId) return reject("WORK_CONTINUATION_WORKSPACE_MISMATCH", continuation, lease);
  if (continuation.task.taskId !== lease.taskId) return reject("WORK_CONTINUATION_TASK_MISMATCH", continuation, lease);
  if (continuation.leaseGeneration > lease.generation) return reject("STALE_WORK_LEASE", continuation, lease);
  if (lease.candidate && lease.candidate !== continuation.candidate.candidateId) {
    return reject("WORK_CONTINUATION_CANDIDATE_MISMATCH", continuation, lease);
  }

  const candidate = continuation.candidate;
  if (candidate.taskId !== continuation.task.taskId || candidate.workspaceId !== continuation.workspaceId) {
    return reject("WORK_CONTINUATION_CANDIDATE_MISMATCH", continuation, lease);
  }
  for (const record of continuation.evidence) {
    if (!candidateBound(record, candidate)) return reject("WORK_CONTINUATION_EVIDENCE_MISMATCH", continuation, lease);
  }
  if (continuation.audit && !candidateBound(continuation.audit, candidate)) {
    return reject("WORK_CONTINUATION_AUDIT_MISMATCH", continuation, lease);
  }

  return Object.freeze({ valid: true, reason: null, continuation });
}
