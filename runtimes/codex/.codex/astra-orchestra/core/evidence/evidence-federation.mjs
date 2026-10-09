import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

function git(repoRoot, args) {
  const res = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (res.error || res.status !== 0) {
    return { ok: false, stdout: "", stderr: String(res.stderr || res.error?.message || "") };
  }
  return { ok: true, stdout: String(res.stdout || "").trim(), stderr: String(res.stderr || "").trim() };
}

export function readEvidenceGitContext(repoRoot) {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const status = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  return {
    ok: head.ok && status.ok,
    headSha: head.ok ? head.stdout : null,
    trackedDirty: status.ok ? status.stdout.length > 0 : null,
    trackedStatus: status.ok ? status.stdout : null,
  };
}

function evidenceHash(parts) {
  return "local-" + createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function activeTaskId(activeState = {}) {
  return activeState.taskId || activeState.taskKey || null;
}

function activeAttempt(activeState = {}) {
  return Number.isInteger(activeState.attempt) && activeState.attempt >= 0 ? activeState.attempt : 0;
}

function activeMutationSeq(activeState = {}) {
  return typeof activeState.mutationSeq === "number"
    ? activeState.mutationSeq
    : typeof activeState.mutation_seq === "number"
      ? activeState.mutation_seq
      : 0;
}

export function bindLocalEvidence({
  evidence,
  activeState = {},
  actor = {},
  repoRoot,
  conversationId = null,
  parentConversationId = null,
} = {}) {
  const out = { ...(evidence || {}) };
  const gitCtx = readEvidenceGitContext(repoRoot);
  const taskId = activeTaskId(activeState);
  const attempt = Number.isInteger(actor.attempt) ? actor.attempt : activeAttempt(activeState);
  const mutationSeq = Number.isInteger(out.mutationSeq) ? out.mutationSeq : activeMutationSeq(activeState);
  const role = String(actor.role || out.actorRole || "UNKNOWN").toUpperCase();
  const confidence = actor.confidence || out.confidence || "LOW";
  const source = actor.source || out.evidenceSource || "UNRESOLVED";
  const actorId = actor.actorId || out.actorId || conversationId || null;
  const delegationKind = actor.delegationKind || out.delegationKind || null;

  out.actorRole = role;
  out.actorId = actorId;
  out.conversationId = conversationId || out.conversationId || actorId;
  out.confidence = confidence;
  out.evidenceSource = source;
  out.delegationKind = delegationKind;
  out.attempt = attempt;
  out.mutationSeq = mutationSeq;
  out.parentConversationId = parentConversationId || out.parentConversationId || null;

  out.binding = {
    ...(out.binding || {}),
    taskId,
    attempt,
    mutationSeq,
    // Clean-worktree evidence is bound to the exact commit. Dirty-worktree
    // evidence is intentionally unbound until a later factual federation step
    // proves the same mutation sequence was committed cleanly.
    commitSha: gitCtx.ok && gitCtx.trackedDirty === false ? gitCtx.headSha : null,
    observedHeadSha: gitCtx.headSha,
    trackedDirtyAtObservation: gitCtx.trackedDirty,
  };

  out.producer = {
    actorId,
    role,
    delegationKind,
    parentConversationId: out.parentConversationId,
    confidence,
    source,
  };

  if (!out.evidenceId) {
    out.evidenceId = evidenceHash({
      executionId: out.executionId || null,
      transcriptEvidenceId: out.transcriptEvidenceId || null,
      conversationId: out.conversationId || null,
      command: out.command || null,
      timestamp: out.timestamp || null,
      taskId,
      attempt,
      mutationSeq,
    });
  }

  return out;
}

function exactEvidenceIdentity(ev) {
  if (ev?.executionId) return "execution:" + ev.executionId;
  if (ev?.transcriptEvidenceId) return "transcript:" + ev.transcriptEvidenceId;
  if (ev?.evidenceId) return "evidence:" + ev.evidenceId;
  return null;
}

export function mergeFederatedEvidence(activeState, evidence) {
  if (!Array.isArray(activeState.evidenceLedger)) activeState.evidenceLedger = [];
  const identity = exactEvidenceIdentity(evidence);
  const idx = identity
    ? activeState.evidenceLedger.findIndex((item) => exactEvidenceIdentity(item) === identity)
    : -1;
  if (idx >= 0) activeState.evidenceLedger[idx] = evidence;
  else activeState.evidenceLedger.push(evidence);
  return evidence;
}

function bindingTaskMatches(binding, activeState) {
  const taskId = activeTaskId(activeState);
  if (!taskId) return true;
  return (binding?.taskIdentifier || binding?.taskId || null) === taskId;
}

function bindingAttemptMatches(binding, activeState) {
  const current = activeAttempt(activeState);
  const attempt = Number.isInteger(binding?.attempt) ? binding.attempt : 0;
  return attempt === current;
}

export function federateDelegatedEvidence({
  activeState = {},
  factualBinding,
  childConversationId,
  parentConversationId = null,
  repoRoot,
} = {}) {
  if (
    !factualBinding
    || factualBinding.confidence !== "HIGH"
    || factualBinding.source !== "RUNTIME_IDENTITY"
    || !childConversationId
    || !bindingTaskMatches(factualBinding, activeState)
    || !bindingAttemptMatches(factualBinding, activeState)
  ) {
    return { promoted: 0, reason: "DELEGATED_IDENTITY_NOT_FACTUAL" };
  }

  if (!Array.isArray(activeState.evidenceLedger)) activeState.evidenceLedger = [];
  const gitCtx = readEvidenceGitContext(repoRoot);
  const currentSeq = activeMutationSeq(activeState);
  let promoted = 0;

  activeState.evidenceLedger = activeState.evidenceLedger.map((ev) => {
    if (!ev) return ev;
    const sameChild = ev.conversationId === childConversationId || ev.actorId === childConversationId;
    if (!sameChild) return ev;

    const currentTaskId = activeTaskId(activeState);
    if (ev.binding?.taskId && currentTaskId && ev.binding.taskId !== currentTaskId) {
      return ev;
    }

    const evAttempt = Number.isInteger(ev.attempt)
      ? ev.attempt
      : Number.isInteger(ev.binding?.attempt)
        ? ev.binding.attempt
        : 0;
    if (evAttempt !== activeAttempt(activeState)) return ev;

    const evSeq = Number.isInteger(ev.mutationSeq)
      ? ev.mutationSeq
      : Number.isInteger(ev.binding?.mutationSeq)
        ? ev.binding.mutationSeq
        : currentSeq;

    const promotedEv = bindLocalEvidence({
      evidence: {
        ...ev,
        mutationSeq: evSeq,
      },
      activeState,
      actor: {
        role: factualBinding.role,
        actorId: childConversationId,
        confidence: "HIGH",
        source: "RUNTIME_IDENTITY",
        delegationKind: factualBinding.delegationKind || null,
        attempt: evAttempt,
      },
      repoRoot,
      conversationId: childConversationId,
      parentConversationId: factualBinding.parentConversationId || parentConversationId || null,
    });

    // Preserve the commit observed at execution when it was already clean.
    if (ev.binding?.commitSha) {
      promotedEv.binding.commitSha = ev.binding.commitSha;
    } else if (
      evSeq === currentSeq
      && gitCtx.ok
      && gitCtx.trackedDirty === false
    ) {
      // The evidence was produced on a dirty candidate, then the same mutation
      // sequence was committed without further tracked mutation. Bind it now.
      promotedEv.binding.commitSha = gitCtx.headSha;
      promotedEv.binding.federatedCommitSha = gitCtx.headSha;
    }

    promotedEv.federation = {
      source: "ORCHESTRA_PARENT_EVIDENCE_FEDERATION",
      childConversationId,
      parentConversationId: factualBinding.parentConversationId || parentConversationId || null,
      promotedAt: new Date().toISOString(),
    };
    promoted++;
    return promotedEv;
  });

  return {
    promoted,
    reason: promoted > 0 ? null : "NO_CHILD_EVIDENCE_TO_FEDERATE",
    commitSha: gitCtx.headSha,
  };
}

export function finalizeActiveTaskEvidenceBindings({
  activeState = {},
  repoRoot,
} = {}) {
  if (!Array.isArray(activeState.evidenceLedger)) return { promoted: 0, headSha: null };
  const gitCtx = readEvidenceGitContext(repoRoot);
  activeState.evidenceCandidateHead = gitCtx.headSha;
  if (!gitCtx.ok || gitCtx.trackedDirty !== false) {
    return { promoted: 0, headSha: gitCtx.headSha };
  }

  const taskId = activeTaskId(activeState);
  const attempt = activeAttempt(activeState);
  const mutationSeq = activeMutationSeq(activeState);
  let promoted = 0;

  activeState.evidenceLedger = activeState.evidenceLedger.map((ev) => {
    if (!ev?.binding) return ev;
    if (taskId && ev.binding.taskId !== taskId) return ev;
    if ((Number.isInteger(ev.binding.attempt) ? ev.binding.attempt : 0) !== attempt) return ev;
    if ((Number.isInteger(ev.binding.mutationSeq) ? ev.binding.mutationSeq : mutationSeq) !== mutationSeq) return ev;

    // Never rewrite evidence that was already bound to a concrete old commit.
    if (ev.binding.commitSha) return ev;

    // Only factual local execution evidence may be finalized this way.
    const confidence = ev.producer?.confidence || ev.confidence;
    const source = ev.producer?.source || ev.evidenceSource;
    if (confidence !== "HIGH") return ev;
    if (!["RUNTIME_IDENTITY", "CONVERSATION_BOUND_IDENTITY"].includes(String(source || ""))) return ev;

    promoted++;
    return {
      ...ev,
      binding: {
        ...ev.binding,
        commitSha: gitCtx.headSha,
        federatedCommitSha: gitCtx.headSha,
      },
      federation: {
        ...(ev.federation || {}),
        source: ev.federation?.source || "ORCHESTRA_ACTIVE_TASK_EVIDENCE_FINALIZER",
        promotedAt: new Date().toISOString(),
      },
    };
  });

  return { promoted, headSha: gitCtx.headSha };
}
