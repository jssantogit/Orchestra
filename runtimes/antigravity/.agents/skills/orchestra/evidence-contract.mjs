import { createHash } from "node:crypto";

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

const RUNTIME_PROVENANCE = new Set([
  "ORCHESTRA_GITHUB_COLLECTOR",
  "ORCHESTRA_LOCAL_FACT_COLLECTOR",
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
  if (!["PASS", "FAIL", "PENDING", "UNAVAILABLE"].includes(record.result)) {
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
      requirements.push(requirement);
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

function validLocalCommandProvenance(ev) {
  const role = String(ev.actorRole || "").toUpperCase();
  const worker = ["WORKER", "FLASH", "FLASH_WORKER", "FLASH_MEDIUM_WORKER", "FLASH_LOW_WORKER"].includes(role);
  return worker
    && ev.confidence === "HIGH"
    && (!ev.delegationKind || ev.delegationKind === "WORK");
}

function validRuntimeProvenance(ev) {
  const validation = validateEvidenceRecord(ev);
  if (!validation.valid) return false;
  return RUNTIME_PROVENANCE.has(ev.provenance?.source);
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

  for (const ev of matching) {
    if (!attemptMatches(ev, activeState)) continue;

    if (requirement.kind === "LOCAL_COMMAND") {
      if (!mutationMatches(ev, activeState)) {
        return { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "STALE", reason: "MUTATION_SEQ_MISMATCH", evidence: ev, requirement };
      }
      if (!validLocalCommandProvenance(ev)) {
        return { id: requirement.id, class: requirement.class, kind: requirement.kind, status: "MISSING_ACTIONABLE", reason: "LOCAL_EVIDENCE_NOT_FACTUAL_WORKER", evidence: ev, requirement };
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
