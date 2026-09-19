import { createHash } from "node:crypto";
import { getEvidenceProvider, validateRemoteEvidenceRequirement } from "./evidence-provider-registry.mjs";

export const EVIDENCE_SCHEMA = "orchestra.evidence.v1";

export const EVIDENCE_STATUS = Object.freeze({
  SATISFIED: "SATISFIED",
  PENDING: "PENDING",
  FAILED: "FAILED",
  MISSING_ACTIONABLE: "MISSING_ACTIONABLE",
  STALE: "STALE",
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
  INVALID_CONTRACT: "INVALID_CONTRACT",
});

const LOCAL_RUNTIME_PROVENANCE = new Set([
  "ORCHESTRA_CODEX_LOCAL_FACT_COLLECTOR",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])])
  );
}

export function hashEvidenceRecord(record) {
  const clone = structuredClone(record || {});
  delete clone.recordHash;
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify(stable(clone)))
    .digest("hex");
}

export function finalizeEvidenceRecord(record) {
  const out = structuredClone(record);
  out.schema = EVIDENCE_SCHEMA;
  out.recordHash = hashEvidenceRecord(out);
  return out;
}

export function validateEvidenceRecord(record) {
  if (!record || record.schema !== EVIDENCE_SCHEMA) {
    return { valid: false, reason: "INVALID_EVIDENCE_SCHEMA" };
  }
  if (!record.evidenceId || !record.requirementId || !record.class || !record.kind) {
    return { valid: false, reason: "INVALID_EVIDENCE_SHAPE" };
  }
  if (!["PASS", "FAIL", "PENDING", "UNAVAILABLE", "STALE"].includes(record.result)) {
    return { valid: false, reason: "INVALID_EVIDENCE_RESULT" };
  }
  if (record.recordHash !== hashEvidenceRecord(record)) {
    return { valid: false, reason: "EVIDENCE_HASH_MISMATCH" };
  }
  return { valid: true };
}

function inferLegacyClass(command) {
  const cmd = String(command || "").trim();
  if (/\b(?:test|vitest|jest|pytest|cargo\s+test|go\s+test)\b/i.test(cmd)) return "LOCAL_TEST";
  if (/\b(?:typecheck|tsc)\b/i.test(cmd)) return "LOCAL_TYPECHECK";
  if (/\b(?:build|gradle|gradlew|mvn)\b/i.test(cmd)) return "LOCAL_BUILD";
  if (/\b(?:lint|eslint|ktlint|spotless)\b/i.test(cmd)) return "LOCAL_LINT";
  if (/\bgit\s+diff\s+--check\b/i.test(cmd)) return "SCOPE_CHECK";
  return "LOCAL_COMMAND";
}

export function normalizeEvidenceRequirements(contract = {}, activeState = {}) {
  const explicit = Array.isArray(contract.requiredEvidence)
    ? contract.requiredEvidence
    : Array.isArray(activeState.requiredEvidence)
      ? activeState.requiredEvidence
      : null;

  if (explicit) {
    const requirements = [];
    for (let i = 0; i < explicit.length; i++) {
      const raw = explicit[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { valid: false, reason: "INVALID_EVIDENCE_REQUIREMENT", index: i, requirements: [] };
      }
      const requirement = {
        ...structuredClone(raw),
        id: String(raw.id || ("evidence-" + (i + 1))),
        class: String(raw.class || "").trim().toUpperCase(),
        kind: String(raw.kind || "").trim().toUpperCase(),
      };
      if (!requirement.class || !requirement.kind) {
        return { valid: false, reason: "INVALID_EVIDENCE_REQUIREMENT", index: i, requirements: [] };
      }
      if (requirements.some((item) => item.id === requirement.id)) {
        return { valid: false, reason: "DUPLICATE_EVIDENCE_REQUIREMENT_ID", index: i, requirements: [] };
      }
      if (requirement.kind === "LOCAL_COMMAND" && !String(requirement.command || "").trim()) {
        return { valid: false, reason: "LOCAL_COMMAND_REQUIRED", index: i, requirements: [] };
      }
      if (requirement.kind === "LOCAL_FACT" && !requirement.class) {
        return { valid: false, reason: "LOCAL_FACT_CLASS_REQUIRED", index: i, requirements: [] };
      }
      if (requirement.kind === "REMOTE_CI") {
        const providerValidation = validateRemoteEvidenceRequirement(requirement);
        if (!providerValidation.valid) {
          return { valid: false, reason: providerValidation.reason, index: i, requirements: [] };
        }
        requirement.provider = providerValidation.provider;
      }
      if (!["LOCAL_COMMAND", "LOCAL_FACT", "REMOTE_CI"].includes(requirement.kind)) {
        return { valid: false, reason: "EVIDENCE_KIND_UNSUPPORTED", index: i, requirements: [] };
      }
      requirements.push(requirement);
    }
    const explicitLegacyTests = Array.isArray(contract.testsRequired)
      ? contract.testsRequired
      : [];
    for (let index = 0; index < explicitLegacyTests.length; index++) {
      const command = explicitLegacyTests[index];
      requirements.push({
        id: "legacy-test-" + (index + 1),
        class: inferLegacyClass(command),
        kind: "LOCAL_COMMAND",
        command: String(command || "").trim(),
        legacy: true,
      });
    }
    return { valid: true, source: "REQUIRED_EVIDENCE", requirements };
  }

  const legacy = Array.isArray(contract.testsRequired)
    ? contract.testsRequired
    : Array.isArray(activeState.testsRequired)
      ? activeState.testsRequired
      : [];

  if (legacy.length > 0) {
    return {
      valid: true,
      source: "LEGACY_TESTS_REQUIRED",
      requirements: legacy.map((command, index) => ({
        id: "legacy-test-" + (index + 1),
        class: inferLegacyClass(command),
        kind: "LOCAL_COMMAND",
        command: String(command || "").trim(),
        legacy: true,
      })),
    };
  }

  return { valid: true, source: "LEGACY_DEFAULT", requirements: [] };
}

function currentAttempt(activeState) {
  return Number.isInteger(activeState?.attempt) && activeState.attempt >= 0
    ? activeState.attempt
    : 0;
}

function currentMutationSeq(activeState) {
  return typeof activeState?.mutationSeq === "number"
    ? activeState.mutationSeq
    : typeof activeState?.mutation_seq === "number"
      ? activeState.mutation_seq
      : 0;
}

function attemptMatches(ev, activeState) {
  const attempt = currentAttempt(activeState);
  if (attempt === 0) return !Number.isInteger(ev.attempt) || ev.attempt === 0 || ev.binding?.attempt === 0;
  return ev.attempt === attempt || ev.binding?.attempt === attempt;
}

function mutationMatches(ev, activeState) {
  const seq = currentMutationSeq(activeState);
  const evidenceSeq = Number.isInteger(ev.binding?.mutationSeq)
    ? ev.binding.mutationSeq
    : Number.isInteger(ev.mutationSeq)
      ? ev.mutationSeq
      : null;
  return evidenceSeq === null || evidenceSeq === seq;
}

function localCommandMatches(requirement, ev) {
  const req = String(requirement.command || "").trim();
  const cmd = String(ev.command || "").trim();
  if (!req || !cmd) return false;
  return cmd.includes(req) || req.includes(cmd);
}

function localProducer(ev) {
  return {
    role: String(ev.producer?.role || ev.actorRole || "").toUpperCase(),
    confidence: ev.producer?.confidence || ev.confidence || "LOW",
    source: ev.producer?.source || ev.evidenceSource || "UNRESOLVED",
    delegationKind: ev.producer?.delegationKind || ev.delegationKind || null,
    parentConversationId: ev.producer?.parentConversationId || ev.parentConversationId || null,
  };
}

function activeTaskId(activeState = {}) {
  return activeState.taskId || activeState.taskKey || null;
}

function localEvidenceTaskMatches(ev, activeState) {
  const taskId = activeTaskId(activeState);
  if (!taskId) return true;
  return ev.binding?.taskId === taskId;
}

function localEvidenceCommitMatches(ev, activeState) {
  const candidateHead = activeState.evidenceCandidateHead || null;
  const evidenceHead = ev.binding?.commitSha || null;
  // Dirty-worktree evidence may be commit-unbound and remains governed by
  // exact task/attempt/mutation freshness. A concrete old commit never matches.
  if (!candidateHead || !evidenceHead) return true;
  return candidateHead === evidenceHead;
}

function validLocalCommandProvenance(ev, activeState) {
  const producer = localProducer(ev);
  const workerRole = ["WORKER", "FLASH", "FLASH_WORKER", "FLASH_MEDIUM_WORKER", "FLASH_LOW_WORKER", "VALIDATOR"].includes(producer.role);
  const delegatedValidation = workerRole
    && ["WORK", "VALIDATION"].includes(String(producer.delegationKind || "WORK").toUpperCase())
    && producer.source === "RUNTIME_IDENTITY";
  const parentValidation = ["ORCHESTRATOR", "FLASH_ORCHESTRATOR"].includes(producer.role)
    && ["RUNTIME_IDENTITY", "CONVERSATION_BOUND_IDENTITY"].includes(producer.source)
    && !producer.delegationKind;
  const parentMatches = !producer.parentConversationId
    || !activeState.conversationId
    || producer.parentConversationId === activeState.conversationId;

  return producer.confidence === "HIGH"
    && parentMatches
    && (delegatedValidation || parentValidation);
}

function validRuntimeProvenance(ev) {
  const validation = validateEvidenceRecord(ev);
  if (!validation.valid) return false;
  const source = ev.provenance?.source;
  if (LOCAL_RUNTIME_PROVENANCE.has(source)) return true;
  const provider = getEvidenceProvider(ev.provider);
  return Boolean(provider && provider.provenanceSource === source);
}

function evaluateRequirement(requirement, ledger, activeState) {
  const matching = ledger.slice().reverse().filter((ev) => {
    if (!ev) return false;
    if (requirement.kind === "LOCAL_COMMAND") {
      return localCommandMatches(requirement, ev);
    }
    return (
      ev.requirementId === requirement.id
      && String(ev.class || "").toUpperCase() === requirement.class
      && String(ev.kind || "").toUpperCase() === requirement.kind
    );
  });

  if (matching.length === 0) {
    return {
      id: requirement.id,
      class: requirement.class,
      kind: requirement.kind,
      status: "MISSING_ACTIONABLE",
      reason: requirement.kind === "LOCAL_COMMAND"
        ? "LOCAL_COMMAND_NOT_EXECUTED"
        : "EVIDENCE_NOT_COLLECTED",
      evidence: null,
      requirement,
    };
  }

  let localFallback = null;
  for (const ev of matching) {
    if (!attemptMatches(ev, activeState)) continue;

    if (requirement.kind === "LOCAL_COMMAND") {
      if (ev.evidenceSource === "CHILD_TRANSCRIPT" && (ev.mutationAfterValidation === true || ev.fresh === false)) {
        localFallback ||= { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "STALE", reason: "CHILD_MUTATION_AFTER_VALIDATION", evidence: ev, requirement };
        continue;
      }
      if (!localEvidenceTaskMatches(ev, activeState)) {
        localFallback ||= { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "STALE", reason: ev.binding?.taskId ? "TASK_ID_MISMATCH" : "TASK_BINDING_MISSING", evidence: ev, requirement };
        continue;
      }
      if (!mutationMatches(ev, activeState)) {
        localFallback ||= { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "STALE", reason: "MUTATION_SEQ_MISMATCH", evidence: ev, requirement };
        continue;
      }
      if (!localEvidenceCommitMatches(ev, activeState)) {
        localFallback ||= { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "STALE", reason: "COMMIT_SHA_MISMATCH", evidence: ev, requirement };
        continue;
      }
      if (!validLocalCommandProvenance(ev, activeState)) {
        localFallback ||= { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "MISSING_ACTIONABLE", reason: "LOCAL_EVIDENCE_PRODUCER_NOT_AUTHORIZED", evidence: ev, requirement };
        continue;
      }
      if (ev.exitCode !== 0 || (Number(ev.failed || 0) > 0)) {
        return { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "FAILED", reason: "LOCAL_COMMAND_FAILED", evidence: ev, requirement };
      }
      return { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "SATISFIED", reason: null, evidence: ev, requirement };
    }

    if (!validRuntimeProvenance(ev)) {
      continue;
    }
    if (!mutationMatches(ev, activeState)) {
      return { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "STALE", reason: "MUTATION_SEQ_MISMATCH", evidence: ev, requirement };
    }

    if (ev.result === "PASS") {
      return { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "SATISFIED", reason: null, evidence: ev, requirement };
    }
    if (ev.result === "PENDING") {
      return { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "PENDING", reason: ev.reason || "EVIDENCE_PENDING", evidence: ev, requirement };
    }
    if (ev.result === "FAIL") {
      return { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "FAILED", reason: ev.reason || "EVIDENCE_FAILED", evidence: ev, requirement };
    }
    if (ev.result === "UNAVAILABLE") {
      return { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "SOURCE_UNAVAILABLE", reason: ev.reason || "EVIDENCE_SOURCE_UNAVAILABLE", evidence: ev, requirement };
    }
    if (ev.result === "STALE") {
      return { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "STALE", reason: ev.reason || "EVIDENCE_STALE", evidence: ev, requirement };
    }
  }

  if (requirement.kind === "LOCAL_COMMAND" && localFallback) {
    return localFallback;
  }

  const crossAttempt = matching[0] || null;
  return {
    id: requirement.id,
    class: requirement.class,
    kind: requirement.kind,
    status: crossAttempt ? "STALE" : "MISSING_ACTIONABLE",
    reason: crossAttempt ? "ATTEMPT_MISMATCH" : "EVIDENCE_NOT_COLLECTED",
    evidence: crossAttempt,
    requirement,
  };
}


function evidenceCandidateIdentity(ev = {}) {
  return ev.evidenceId
    || ev.executionId
    || ev.transcriptEvidenceId
    || ev.run?.id
    || null;
}

function candidateSummary(ev = {}) {
  const producer = localProducer(ev);
  return {
    evidenceId: evidenceCandidateIdentity(ev),
    requirementId: ev.requirementId || null,
    class: ev.class || ev.type || null,
    kind: ev.kind || null,
    result: ev.result || null,
    command: ev.command || null,
    exitCode: Number.isInteger(ev.exitCode) ? ev.exitCode : null,
    producer: {
      actorId: ev.producer?.actorId || ev.actorId || null,
      role: producer.role || null,
      delegationKind: producer.delegationKind || null,
      confidence: producer.confidence || null,
      source: producer.source || null,
      parentConversationId: producer.parentConversationId || null,
    },
    binding: ev.binding ? {
      taskId: ev.binding.taskId || null,
      attempt: Number.isInteger(ev.binding.attempt) ? ev.binding.attempt : null,
      mutationSeq: Number.isInteger(ev.binding.mutationSeq) ? ev.binding.mutationSeq : null,
      commitSha: ev.binding.commitSha || null,
      observedHeadSha: ev.binding.observedHeadSha || null,
    } : null,
    provider: ev.provider || null,
    repository: ev.repository || null,
    workflow: ev.workflow || null,
    run: ev.run ? {
      id: ev.run.id || null,
      attempt: ev.run.attempt || null,
      headSha: ev.run.headSha || null,
      headBranch: ev.run.headBranch || null,
      status: ev.run.status || null,
      conclusion: ev.run.conclusion || null,
    } : null,
    provenance: ev.provenance ? {
      source: ev.provenance.source || null,
      observedAt: ev.provenance.observedAt || null,
    } : null,
    timestamp: ev.timestamp || null,
  };
}

function diagnoseCandidate(requirement, ev, activeState) {
  const summary = candidateSummary(ev);

  if (!attemptMatches(ev, activeState)) {
    return { ...summary, status: "REJECTED", reason: "ATTEMPT_MISMATCH" };
  }

  if (requirement.kind === "LOCAL_COMMAND") {
    if (ev.evidenceSource === "CHILD_TRANSCRIPT" && (ev.mutationAfterValidation === true || ev.fresh === false)) {
      return { ...summary, status: "REJECTED", reason: "CHILD_MUTATION_AFTER_VALIDATION" };
    }
    if (!localEvidenceTaskMatches(ev, activeState)) {
      return {
        ...summary,
        status: "REJECTED",
        reason: ev.binding?.taskId ? "TASK_ID_MISMATCH" : "TASK_BINDING_MISSING",
      };
    }
    if (!mutationMatches(ev, activeState)) {
      return { ...summary, status: "REJECTED", reason: "MUTATION_SEQ_MISMATCH" };
    }
    if (!localEvidenceCommitMatches(ev, activeState)) {
      return { ...summary, status: "REJECTED", reason: "COMMIT_SHA_MISMATCH" };
    }
    if (!validLocalCommandProvenance(ev, activeState)) {
      return { ...summary, status: "REJECTED", reason: "LOCAL_EVIDENCE_PRODUCER_NOT_AUTHORIZED" };
    }
    if (ev.exitCode !== 0 || Number(ev.failed || 0) > 0) {
      return { ...summary, status: "FAILED", reason: "LOCAL_COMMAND_FAILED" };
    }
    return { ...summary, status: "SATISFIED", reason: null };
  }

  if (!validRuntimeProvenance(ev)) {
    const validation = validateEvidenceRecord(ev);
    return {
      ...summary,
      status: "REJECTED",
      reason: validation.valid ? "RUNTIME_EVIDENCE_PROVENANCE_INVALID" : validation.reason,
    };
  }
  if (!mutationMatches(ev, activeState)) {
    return { ...summary, status: "REJECTED", reason: "MUTATION_SEQ_MISMATCH" };
  }

  if (ev.result === "PASS") return { ...summary, status: "SATISFIED", reason: null };
  if (ev.result === "PENDING") return { ...summary, status: "PENDING", reason: ev.reason || "EVIDENCE_PENDING" };
  if (ev.result === "FAIL") return { ...summary, status: "FAILED", reason: ev.reason || "EVIDENCE_FAILED" };
  if (ev.result === "UNAVAILABLE") return { ...summary, status: "SOURCE_UNAVAILABLE", reason: ev.reason || "EVIDENCE_SOURCE_UNAVAILABLE" };
  if (ev.result === "STALE") return { ...summary, status: "STALE", reason: ev.reason || "EVIDENCE_STALE" };

  return { ...summary, status: "REJECTED", reason: "EVIDENCE_RESULT_UNRECOGNIZED" };
}

function relevantEvidenceCandidates(requirement, ledger) {
  return ledger.slice().reverse().filter((ev) => {
    if (!ev) return false;
    if (requirement.kind === "LOCAL_COMMAND") return localCommandMatches(requirement, ev);
    return (
      ev.requirementId === requirement.id
      && String(ev.class || "").toUpperCase() === requirement.class
      && String(ev.kind || "").toUpperCase() === requirement.kind
    );
  });
}

export function explainEvidenceContract({ activeState = {}, contract = null, evidenceLedger = null } = {}) {
  const verification = verifyEvidenceContract({ activeState, contract, evidenceLedger });
  const ledger = Array.isArray(evidenceLedger)
    ? evidenceLedger
    : Array.isArray(activeState.evidenceLedger)
      ? activeState.evidenceLedger
      : [];

  const requirements = Array.isArray(verification.requirements)
    ? verification.requirements
    : [];

  const explained = requirements.map((requirement) => {
    const result = verification.results.find((item) => item.id === requirement.id) || null;
    const candidates = relevantEvidenceCandidates(requirement, ledger)
      .map((ev) => diagnoseCandidate(requirement, ev, activeState));

    return {
      id: requirement.id,
      class: requirement.class,
      kind: requirement.kind,
      status: result?.status || "UNKNOWN",
      reason: result?.reason || null,
      requirement,
      selectedEvidenceId: evidenceCandidateIdentity(result?.evidence || {}),
      candidateCount: candidates.length,
      candidates,
    };
  });

  return {
    status: verification.status,
    verified: verification.verified,
    fresh: verification.fresh,
    reason: verification.reason,
    source: verification.source || null,
    ledgerCount: ledger.length,
    relevantCandidateCount: explained.reduce((sum, item) => sum + item.candidateCount, 0),
    unrelatedLedgerCount: Math.max(
      0,
      ledger.length - new Set(
        explained.flatMap((item) => item.candidates.map((candidate) => candidate.evidenceId).filter(Boolean))
      ).size
    ),
    requirements: explained,
  };
}

export function verifyEvidenceContract({ activeState = {}, contract = null, evidenceLedger = null } = {}) {
  const effectiveContract = contract || activeState.scopeContract || {};
  const normalized = normalizeEvidenceRequirements(effectiveContract, activeState);
  if (!normalized.valid) {
    return {
      status: EVIDENCE_STATUS.INVALID_CONTRACT,
      verified: false,
      fresh: false,
      reason: normalized.reason,
      requirements: [],
      results: [],
    };
  }

  if (normalized.requirements.length === 0) {
    return {
      status: EVIDENCE_STATUS.SATISFIED,
      verified: true,
      fresh: true,
      reason: null,
      source: normalized.source,
      requirements: [],
      results: [],
    };
  }

  const ledger = Array.isArray(evidenceLedger)
    ? evidenceLedger
    : Array.isArray(activeState.evidenceLedger)
      ? activeState.evidenceLedger
      : [];
  const results = normalized.requirements.map((req) => evaluateRequirement(req, ledger, activeState));

  const precedence = [
    "INVALID_CONTRACT",
    "FAILED",
    "SOURCE_UNAVAILABLE",
    "STALE",
    "PENDING",
    "MISSING_ACTIONABLE",
  ];
  const unsatisfied = results.filter((r) => r.status !== "SATISFIED");
  const status = unsatisfied.length === 0
    ? EVIDENCE_STATUS.SATISFIED
    : precedence.find((candidate) => unsatisfied.some((r) => r.status === candidate))
      || EVIDENCE_STATUS.MISSING_ACTIONABLE;

  return {
    status,
    verified: status === EVIDENCE_STATUS.SATISFIED,
    fresh: status === EVIDENCE_STATUS.SATISFIED,
    reason: unsatisfied[0]?.reason || null,
    source: normalized.source,
    requirements: normalized.requirements,
    results,
    evidence: results.find((r) => r.status === "SATISFIED")?.evidence || null,
  };
}

export function childOwnedMissingRequirements(contractResult) {
  if (!contractResult || !Array.isArray(contractResult.results)) return [];
  return contractResult.results
    .filter((r) => r.status === "MISSING_ACTIONABLE" && r.kind === "LOCAL_COMMAND")
    .map((r) => r.requirement);
}
