import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

export function findFactualSubagentRecord({
  parentConversationId,
  childConversationId,
  brainBaseDir = process.env.AGY_BRAIN_DIR || join(homedir(), ".gemini/antigravity-cli/brain"),
} = {}) {
  if (!parentConversationId || !childConversationId) return null;

  const subagentsDir = join(brainBaseDir, parentConversationId, ".system_generated/subagents");
  if (!existsSync(subagentsDir)) return null;

  try {
    for (const file of readdirSync(subagentsDir)) {
      if (!file.endsWith(".json")) continue;
      let record;
      try {
        record = JSON.parse(readFileSync(join(subagentsDir, file), "utf-8"));
      } catch {
        continue;
      }
      if (record?.conversationId === childConversationId) {
        return record;
      }
    }
  } catch {}

  return null;
}

export function factualSubagentMatchesPending(record, pending) {
  if (!record || !pending) return false;
  const descriptor = record.subagentDescriptor || {};
  const descTypeName = String(descriptor.typeName || "").trim();
  const descRole = normalizeRole(descriptor.role);

  // A factual child record without any descriptor cannot prove which pending
  // delegation it belongs to.
  if (!descTypeName && !descRole) return false;

  const pendingProfile = String(pending.profile || pending.typeName || "").trim();
  const pendingRole = normalizeRole(pending.role);

  let comparableDimensions = 0;

  // Strong descriptor dimensions are conjunctive, not alternatives. A factual
  // profile conflict cannot be forgiven merely because both delegations say "worker".
  if (descTypeName && pendingProfile) {
    comparableDimensions++;
    if (descTypeName !== pendingProfile) return false;
  }

  if (descRole && pendingRole) {
    comparableDimensions++;
    const roleMatches = descRole === pendingRole || descRole.includes(pendingRole);
    if (!roleMatches) return false;
  }

  // At least one descriptor dimension must be comparable to the pending slot.
  if (comparableDimensions === 0) return false;

  const spawnStepIndex = record.spawnStepIndex;
  const originStepIdx = pending.originStepIdx;
  const originStepNumber = originStepIdx === null || originStepIdx === undefined ? null : Number(originStepIdx);
  const spawnStepNumber = spawnStepIndex === null || spawnStepIndex === undefined ? null : Number(spawnStepIndex);

  // When dispatch recorded an origin step, the factual runtime record must prove
  // the same spawn step. Missing spawn identity is not equivalent to a match.
  if (Number.isInteger(originStepNumber)) {
    if (!Number.isInteger(spawnStepNumber) || spawnStepNumber !== originStepNumber) {
      return false;
    }
  }

  return true;
}

export function filterFactualPendingCandidates({
  pendingSubagents = [],
  record,
  parentConversationId = null,
  taskId = null,
  benchmarkRunId = null,
  attempt = 0,
} = {}) {
  let candidates = Array.isArray(pendingSubagents)
    ? pendingSubagents.filter((p) => !p.consumed)
    : [];

  if (parentConversationId) {
    candidates = candidates.filter((p) => p.parentConversationId === parentConversationId);
  }
  if (taskId) {
    candidates = candidates.filter((p) => (p.taskIdentifier || p.taskId) === taskId);
  }
  if (benchmarkRunId) {
    candidates = candidates.filter((p) => p.benchmarkRunId === benchmarkRunId);
  }

  const activeAttempt = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0;
  candidates = candidates.filter((p) => {
    const pendingAttempt = Number.isInteger(p?.attempt) && p.attempt >= 0 ? p.attempt : 0;
    return pendingAttempt === activeAttempt;
  });

  return candidates.filter((p) => factualSubagentMatchesPending(record, p));
}

export function isSymmetricReviewerSet(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length < 2) return false;
  const firstRole = candidates[0].role;
  const firstProfile = candidates[0].profile;
  return (
    firstRole === "REVIEWER" &&
    candidates.every(
      (c) =>
        c.role === firstRole &&
        c.profile === firstProfile &&
        c.delegationKind === "REVIEW"
    )
  );
}
