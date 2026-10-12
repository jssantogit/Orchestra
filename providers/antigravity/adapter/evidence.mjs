import { assertEvidence } from "../../../core/domain/evidence.mjs";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeStatus(value) {
  const status = clean(value, 80).toLowerCase();
  if (["success", "passed", "pass", "completed", "complete", "ok"].includes(status)) return "PASSED";
  if (["failure", "failed", "fail", "error", "cancelled", "canceled", "timed_out", "timeout"].includes(status)) return "FAILED";
  if (["running", "pending", "in_progress", "queued"].includes(status)) return "RUNNING";
  return "MISSING";
}

function sourceReference(record) {
  const explicit = clean(record?.source?.reference || record?.reference, 500);
  if (explicit) return explicit;
  const runId = clean(record?.run_id || record?.runId, 300);
  if (runId) return `run:${runId}`;
  const toolCallId = clean(record?.toolCallId || record?.tool_call_id, 300);
  if (toolCallId) return `tool:${toolCallId}`;
  const invocationId = clean(record?.invocationId || record?.invocation_id, 300);
  if (invocationId) return `invocation:${invocationId}`;
  const evidenceId = clean(record?.evidence_id || record?.evidenceId || record?.id, 300);
  if (evidenceId) return `evidence:${evidenceId}`;
  throw new TypeError("ANTIGRAVITY_EVIDENCE_REFERENCE_REQUIRED");
}

export function normalizeProviderEvidence(providerRecord = {}) {
  const evidence = {
    schema: "orchestra.evidence.v1",
    taskId: clean(providerRecord.taskId || providerRecord.task_id, 300),
    candidateId: clean(providerRecord.candidateId || providerRecord.candidate_id, 300),
    candidateGeneration: Number(providerRecord.candidateGeneration ?? providerRecord.candidate_generation),
    kind: clean(providerRecord.kind || providerRecord.evidence_kind || "PROVIDER_EVIDENCE", 120),
    status: normalizeStatus(providerRecord.result ?? providerRecord.status ?? providerRecord.conclusion),
    source: {
      provider: "antigravity",
      reference: sourceReference(providerRecord),
    },
  };
  assertEvidence(evidence);
  return evidence;
}
