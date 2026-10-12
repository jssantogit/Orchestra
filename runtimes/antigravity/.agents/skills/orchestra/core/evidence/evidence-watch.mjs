export const EVIDENCE_WATCH_SCHEMA = "orchestra.evidence-watch.v1";

export const DEFAULT_EVIDENCE_WATCH_POLICY = Object.freeze({
  initialBackoffMs: 15000,
  maxBackoffMs: 120000,
  timeoutMs: 30 * 60 * 1000,
});

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function taskBinding(activeState = {}) {
  return {
    taskId: activeState.taskId || activeState.taskKey || null,
    attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
    mutationSeq: typeof activeState.mutationSeq === "number"
      ? activeState.mutationSeq
      : typeof activeState.mutation_seq === "number"
        ? activeState.mutation_seq
        : 0,
    commitSha: activeState.evidenceCandidateHead || null,
  };
}

function sameBinding(a = {}, b = {}) {
  return (a.taskId || null) === (b.taskId || null)
    && Number(a.attempt || 0) === Number(b.attempt || 0)
    && Number(a.mutationSeq || 0) === Number(b.mutationSeq || 0)
    && (!a.commitSha || !b.commitSha || a.commitSha === b.commitSha);
}

function watchPolicy(requirement = {}) {
  const raw = requirement.watchPolicy && typeof requirement.watchPolicy === "object"
    ? requirement.watchPolicy
    : {};
  const initialBackoffMs = Math.max(
    1000,
    Number(raw.initialBackoffMs || DEFAULT_EVIDENCE_WATCH_POLICY.initialBackoffMs)
  );
  const maxBackoffMs = Math.max(
    initialBackoffMs,
    Number(raw.maxBackoffMs || DEFAULT_EVIDENCE_WATCH_POLICY.maxBackoffMs)
  );
  const timeoutMs = Math.max(
    initialBackoffMs,
    Number(raw.timeoutMs || DEFAULT_EVIDENCE_WATCH_POLICY.timeoutMs)
  );
  return { initialBackoffMs, maxBackoffMs, timeoutMs };
}

function ensureWatchMap(activeState) {
  if (!activeState.evidenceWatches || typeof activeState.evidenceWatches !== "object" || Array.isArray(activeState.evidenceWatches)) {
    activeState.evidenceWatches = {};
  }
  return activeState.evidenceWatches;
}

export function getEvidenceWatch(activeState = {}, requirementId) {
  return activeState.evidenceWatches?.[String(requirementId)] || null;
}

export function ensureEvidenceWatch(activeState, requirement, nowMs = Date.now()) {
  const watches = ensureWatchMap(activeState);
  const id = String(requirement.id);
  const currentBinding = taskBinding(activeState);
  const existing = watches[id];

  if (
    existing
    && existing.schema === EVIDENCE_WATCH_SCHEMA
    && sameBinding(existing.binding, currentBinding)
    && existing.provider === String(requirement.provider || "").toUpperCase()
  ) {
    return existing;
  }

  const policy = watchPolicy(requirement);
  const watch = {
    schema: EVIDENCE_WATCH_SCHEMA,
    requirementId: id,
    provider: String(requirement.provider || "").toUpperCase(),
    status: "READY_TO_POLL",
    binding: currentBinding,
    startedAt: nowIso(nowMs),
    startedAtMs: nowMs,
    deadlineAt: nowIso(nowMs + policy.timeoutMs),
    deadlineAtMs: nowMs + policy.timeoutMs,
    nextPollAt: nowIso(nowMs),
    nextPollAtMs: nowMs,
    pollCount: 0,
    backoffMs: policy.initialBackoffMs,
    initialBackoffMs: policy.initialBackoffMs,
    maxBackoffMs: policy.maxBackoffMs,
    timeoutMs: policy.timeoutMs,
    lastResult: null,
    lastReason: null,
    lastEvidenceId: null,
    terminalAt: null,
  };
  watches[id] = watch;
  return watch;
}

export function shouldPollEvidenceWatch(activeState, requirement, nowMs = Date.now(), { force = false } = {}) {
  const watch = ensureEvidenceWatch(activeState, requirement, nowMs);
  const currentBinding = taskBinding(activeState);

  if (!sameBinding(watch.binding, currentBinding)) {
    return { poll: false, expired: true, reason: "WATCH_BINDING_STALE", watch };
  }
  if (watch.status.startsWith("TERMINAL_")) {
    return { poll: false, terminal: true, reason: watch.status, watch };
  }
  if (nowMs >= Number(watch.deadlineAtMs || 0)) {
    watch.status = "TIMED_OUT";
    watch.lastReason = "EVIDENCE_WATCH_TIMEOUT";
    return { poll: false, timedOut: true, reason: "EVIDENCE_WATCH_TIMEOUT", watch };
  }
  if (!force && nowMs < Number(watch.nextPollAtMs || 0)) {
    return { poll: false, waiting: true, reason: "WATCH_BACKOFF", watch };
  }
  return { poll: true, reason: null, watch };
}

export function noteEvidenceWatchResult(activeState, requirement, record, nowMs = Date.now()) {
  const watch = ensureEvidenceWatch(activeState, requirement, nowMs);
  const result = String(record?.result || "UNAVAILABLE").toUpperCase();
  watch.pollCount += 1;
  watch.lastResult = result;
  watch.lastReason = record?.reason || null;
  watch.lastEvidenceId = record?.evidenceId || null;
  watch.lastObservedAt = nowIso(nowMs);

  if (["PASS", "FAIL", "STALE"].includes(result)) {
    watch.status = "TERMINAL_" + result;
    watch.terminalAt = nowIso(nowMs);
    watch.nextPollAt = null;
    watch.nextPollAtMs = null;
    return watch;
  }

  if (result === "UNAVAILABLE") {
    watch.status = "SOURCE_UNAVAILABLE";
  } else {
    watch.status = "PENDING";
  }

  const nextBackoff = Math.min(
    Number(watch.maxBackoffMs),
    Math.max(Number(watch.initialBackoffMs), Number(watch.backoffMs || watch.initialBackoffMs))
      * (watch.pollCount <= 1 ? 1 : 2)
  );
  watch.backoffMs = nextBackoff;
  watch.nextPollAtMs = Math.min(
    Number(watch.deadlineAtMs),
    nowMs + nextBackoff
  );
  watch.nextPollAt = nowIso(watch.nextPollAtMs);
  return watch;
}

export function markEvidenceWatchTimedOut(activeState, requirement, nowMs = Date.now()) {
  const watch = ensureEvidenceWatch(activeState, requirement, nowMs);
  watch.status = "TIMED_OUT";
  watch.lastResult = "UNAVAILABLE";
  watch.lastReason = "EVIDENCE_WATCH_TIMEOUT";
  watch.terminalAt = nowIso(nowMs);
  watch.nextPollAt = null;
  watch.nextPollAtMs = null;
  return watch;
}

export function summarizeEvidenceWatches(activeState = {}) {
  const watches = Object.values(activeState.evidenceWatches || {});
  return {
    count: watches.length,
    pending: watches.filter((watch) => ["PENDING", "READY_TO_POLL", "SOURCE_UNAVAILABLE"].includes(watch.status)).length,
    terminal: watches.filter((watch) => String(watch.status || "").startsWith("TERMINAL_")).length,
    timedOut: watches.filter((watch) => watch.status === "TIMED_OUT").length,
    watches: watches.map((watch) => ({
      requirementId: watch.requirementId,
      provider: watch.provider,
      status: watch.status,
      pollCount: watch.pollCount,
      nextPollAt: watch.nextPollAt,
      deadlineAt: watch.deadlineAt,
      lastResult: watch.lastResult,
      lastReason: watch.lastReason,
      lastEvidenceId: watch.lastEvidenceId,
      binding: watch.binding,
    })),
  };
}

export function clearEvidenceWatchesForNewTask(activeState = {}) {
  if (!activeState.evidenceWatches) return 0;
  const binding = taskBinding(activeState);
  let removed = 0;
  for (const [id, watch] of Object.entries(activeState.evidenceWatches)) {
    if (!sameBinding(watch.binding, binding)) {
      delete activeState.evidenceWatches[id];
      removed++;
    }
  }
  return removed;
}
