import { createHash } from "node:crypto";

import { finalizeEvidenceRecord } from "./evidence-contract.mjs";
import { getEvidenceProvider } from "./evidence-provider-registry.mjs";

export const CODEX_EVIDENCE_COLLECTOR_SCHEMA = "orchestra.codex-evidence-collector.v1";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function evidenceId(prefix, value) {
  return prefix + "-" + createHash("sha256").update(JSON.stringify(stable(value))).digest("hex").slice(0, 24);
}

function binding(activeState = {}, overrides = {}) {
  return {
    taskId: overrides.taskId ?? activeState.taskId ?? activeState.taskKey ?? null,
    attempt: Number.isInteger(overrides.attempt)
      ? overrides.attempt
      : (Number.isInteger(activeState.attempt) ? activeState.attempt : 0),
    mutationSeq: Number.isInteger(overrides.mutationSeq)
      ? overrides.mutationSeq
      : (Number.isInteger(activeState.mutationSeq) ? activeState.mutationSeq : 0),
    commitSha: overrides.commitSha ?? activeState.evidenceCandidateHead ?? null,
  };
}

function resultFromExit(exitCode, failed = 0) {
  if (!Number.isInteger(exitCode)) return "UNAVAILABLE";
  return exitCode === 0 && Number(failed || 0) === 0 ? "PASS" : "FAIL";
}

export function collectCodexCommandEvidence({
  requirement,
  commandResult,
  activeState = {},
  actor = {},
  bindingOverrides = {},
} = {}) {
  if (!requirement || String(requirement.kind || "").toUpperCase() !== "LOCAL_COMMAND") {
    throw new Error("CODEX_LOCAL_COMMAND_REQUIREMENT_REQUIRED");
  }
  const command = String(commandResult?.command || requirement.command || "").trim();
  if (!command) throw new Error("CODEX_COMMAND_REQUIRED");

  const producer = {
    role: String(actor.role || "WORKER").toUpperCase(),
    confidence: String(actor.confidence || "HIGH").toUpperCase(),
    source: actor.source || "RUNTIME_IDENTITY",
    actorId: actor.actorId || actor.conversationId || null,
    conversationId: actor.conversationId || actor.actorId || null,
    parentConversationId: actor.parentConversationId || null,
    delegationKind: actor.delegationKind || (String(actor.role || "WORKER").toUpperCase() === "ORCHESTRATOR" ? null : "WORK"),
  };
  const body = {
    collectorSchema: CODEX_EVIDENCE_COLLECTOR_SCHEMA,
    requirementId: String(requirement.id),
    class: String(requirement.class || "LOCAL_COMMAND").toUpperCase(),
    kind: "LOCAL_COMMAND",
    command,
    exitCode: Number.isInteger(commandResult?.exitCode) ? commandResult.exitCode : null,
    failed: Number(commandResult?.failed || 0),
    result: resultFromExit(commandResult?.exitCode, commandResult?.failed),
    reason: commandResult?.error ? "COMMAND_EXECUTION_ERROR" : null,
    binding: binding(activeState, bindingOverrides),
    producer,
    actorRole: producer.role,
    actorId: producer.actorId,
    conversationId: producer.conversationId,
    parentConversationId: producer.parentConversationId,
    confidence: producer.confidence,
    evidenceSource: producer.source,
    delegationKind: producer.delegationKind,
    observedAt: commandResult?.observedAt || new Date().toISOString(),
  };
  return finalizeEvidenceRecord({
    ...body,
    evidenceId: evidenceId("codex-local", body),
  });
}

export function collectCodexLocalFactEvidence({
  requirement,
  value,
  passed = true,
  activeState = {},
  bindingOverrides = {},
} = {}) {
  if (!requirement || String(requirement.kind || "").toUpperCase() !== "LOCAL_FACT") {
    throw new Error("CODEX_LOCAL_FACT_REQUIREMENT_REQUIRED");
  }
  const body = {
    collectorSchema: CODEX_EVIDENCE_COLLECTOR_SCHEMA,
    requirementId: String(requirement.id),
    class: String(requirement.class || "").toUpperCase(),
    kind: "LOCAL_FACT",
    result: passed ? "PASS" : "FAIL",
    value: stable(value),
    binding: binding(activeState, bindingOverrides),
    provenance: { source: "ORCHESTRA_CODEX_LOCAL_FACT_COLLECTOR" },
    observedAt: new Date().toISOString(),
  };
  return finalizeEvidenceRecord({
    ...body,
    evidenceId: evidenceId("codex-fact", body),
  });
}

export function collectCodexRemoteCiEvidence({
  requirement,
  observation,
  activeState = {},
  bindingOverrides = {},
} = {}) {
  if (!requirement || String(requirement.kind || "").toUpperCase() !== "REMOTE_CI") {
    throw new Error("CODEX_REMOTE_CI_REQUIREMENT_REQUIRED");
  }
  const provider = getEvidenceProvider(requirement.provider);
  if (!provider) throw new Error("CODEX_REMOTE_CI_PROVIDER_UNSUPPORTED");

  const state = String(observation?.status || observation?.conclusion || "").toUpperCase();
  const result = ["SUCCESS", "PASS", "PASSED", "GREEN"].includes(state)
    ? "PASS"
    : ["FAILURE", "FAILED", "FAIL", "ERROR", "CANCELLED", "TIMED_OUT"].includes(state)
      ? "FAIL"
      : ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(state)
        ? "PENDING"
        : "UNAVAILABLE";

  const body = {
    collectorSchema: CODEX_EVIDENCE_COLLECTOR_SCHEMA,
    requirementId: String(requirement.id),
    class: String(requirement.class || "REMOTE_CI").toUpperCase(),
    kind: "REMOTE_CI",
    provider: provider.id,
    result,
    reason: result === "UNAVAILABLE" ? "REMOTE_CI_STATE_UNKNOWN" : null,
    workflow: stable(requirement.workflow || null),
    requiredJobs: Array.isArray(requirement.requiredJobs) ? [...requirement.requiredJobs] : [],
    runId: observation?.runId ?? observation?.run_id ?? null,
    runUrl: observation?.runUrl ?? observation?.url ?? null,
    jobs: Array.isArray(observation?.jobs) ? stable(observation.jobs) : [],
    binding: binding(activeState, {
      ...bindingOverrides,
      commitSha: bindingOverrides.commitSha ?? observation?.commitSha ?? observation?.headSha,
    }),
    provenance: { source: provider.provenanceSource },
    observedAt: observation?.observedAt || new Date().toISOString(),
  };
  return finalizeEvidenceRecord({
    ...body,
    evidenceId: evidenceId("codex-remote", body),
  });
}
