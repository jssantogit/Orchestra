import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { collectRuntimeEvidenceSync } from "./evidence-collectors.mjs";
import { verifyEvidenceContract } from "./evidence-contract.mjs";
import { summarizeEvidenceWatches } from "./evidence-watch.mjs";

export const EVIDENCE_WATCH_RUNNER_SCHEMA = "orchestra.evidence-watch-runner.v1";

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + ".tmp-" + process.pid;
  const fd = openSync(temp, "w");
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

function bindingOf(state = {}) {
  return {
    taskId: state.taskId || state.taskKey || null,
    attempt: Number.isInteger(state.attempt) ? state.attempt : 0,
    mutationSeq: typeof state.mutationSeq === "number"
      ? state.mutationSeq
      : typeof state.mutation_seq === "number"
        ? state.mutation_seq
        : 0,
  };
}

function sameBinding(a = {}, b = {}) {
  return (a.taskId || null) === (b.taskId || null)
    && Number(a.attempt || 0) === Number(b.attempt || 0)
    && Number(a.mutationSeq || 0) === Number(b.mutationSeq || 0);
}

function lockPath(repoRoot) {
  return join(repoRoot, ".agents", "state", "evidence-watch-runner.json");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runnerPayload({ repoRoot, statePath, contractPath, expectedBinding }) {
  return Buffer.from(JSON.stringify({
    repoRoot,
    statePath,
    contractPath,
    expectedBinding,
  }), "utf8").toString("base64url");
}

export function launchEvidenceWatchRunner({
  repoRoot,
  statePath,
  contractPath,
  activeState,
} = {}) {
  const root = resolve(repoRoot);
  const expectedBinding = bindingOf(activeState);
  const lock = lockPath(root);
  const existing = readJson(lock, null);

  if (
    existing
    && existing.schema === EVIDENCE_WATCH_RUNNER_SCHEMA
    && sameBinding(existing.binding, expectedBinding)
    && pidAlive(existing.pid)
  ) {
    return {
      launched: false,
      alreadyRunning: true,
      pid: existing.pid,
      binding: expectedBinding,
      startedAt: existing.startedAt || null,
    };
  }

  if (existing) rmSync(lock, { force: true });

  const selfPath = fileURLToPath(import.meta.url);
  const payload = runnerPayload({
    repoRoot: root,
    statePath: resolve(statePath),
    contractPath: resolve(contractPath),
    expectedBinding,
  });

  const child = spawn(process.execPath, [selfPath, "--run-watch", payload], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const record = {
    schema: EVIDENCE_WATCH_RUNNER_SCHEMA,
    pid: child.pid,
    binding: expectedBinding,
    startedAt: new Date().toISOString(),
    status: "RUNNING",
  };
  atomicWriteJson(lock, record);

  return {
    launched: true,
    alreadyRunning: false,
    pid: child.pid,
    binding: expectedBinding,
    startedAt: record.startedAt,
  };
}

function currentContract(state, contractPath) {
  return readJson(contractPath, null) || state.scopeContract || {};
}

function currentNextPollMs(state) {
  const watches = Object.values(state.evidenceWatches || {})
    .filter((watch) => ["PENDING", "READY_TO_POLL", "SOURCE_UNAVAILABLE"].includes(watch.status))
    .map((watch) => Number(watch.nextPollAtMs || Date.now()))
    .filter(Number.isFinite);
  return watches.length > 0 ? Math.min(...watches) : Date.now();
}

function hasTimedOutWatch(state) {
  return Object.values(state.evidenceWatches || {}).some((watch) => watch.status === "TIMED_OUT");
}

export function runEvidenceWatchCycle({
  repoRoot,
  statePath,
  contractPath,
  expectedBinding,
  nowMs = Date.now(),
} = {}) {
  const state = readJson(statePath, null);
  if (!state) return { done: true, reason: "ACTIVE_STATE_UNREADABLE" };
  if (!sameBinding(bindingOf(state), expectedBinding)) {
    return { done: true, reason: "WATCH_TASK_CHANGED" };
  }
  if (String(state.state || "").toUpperCase() !== "CI_WAIT") {
    return { done: true, reason: "STATE_NOT_CI_WAIT" };
  }

  const contract = currentContract(state, contractPath);
  const collection = collectRuntimeEvidenceSync({
    repoRoot,
    activeState: state,
    contract,
    forceRemotePoll: true,
    nowMs,
  });
  const verification = verifyEvidenceContract({
    activeState: state,
    contract,
    evidenceLedger: state.evidenceLedger || [],
  });

  const watchSummary = summarizeEvidenceWatches(state);
  state.lastEvidenceCollection = {
    collected: collection.collected === true,
    reason: collection.reason || null,
    remotePollPerformed: collection.remotePollPerformed === true,
    records: (collection.records || []).map((record) => ({
      evidenceId: record.evidenceId,
      requirementId: record.requirementId,
      class: record.class,
      kind: record.kind,
      result: record.result,
      reason: record.reason || null,
    })),
    skipped: collection.skipped || [],
    observedAt: new Date(nowMs).toISOString(),
    actor: "EVIDENCE_WATCH_RUNNER",
  };
  state.evidenceContractStatus = verification.status;

  const terminal = ["SATISFIED", "FAILED", "STALE", "INVALID_CONTRACT"].includes(verification.status)
    || (verification.status === "SOURCE_UNAVAILABLE" && hasTimedOutWatch(state));

  if (terminal) {
    state.state = "EVIDENCE_READY";
    state.ciWait = {
      ...(state.ciWait || {}),
      watchSummary,
      status: "TERMINAL_EVIDENCE_READY",
      terminalEvidenceStatus: verification.status,
      completedAt: new Date(nowMs).toISOString(),
    };
    atomicWriteJson(statePath, state);
    return {
      done: true,
      reason: "TERMINAL_EVIDENCE_READY",
      verificationStatus: verification.status,
      state,
    };
  }

  state.state = "CI_WAIT";
  state.ciWait = {
    ...(state.ciWait || {}),
    watchSummary,
    status: "WATCHING",
    nextPollAt: watchSummary.watches
      .map((watch) => watch.nextPollAt)
      .filter(Boolean)
      .sort()[0] || null,
    deadlineAt: watchSummary.watches
      .map((watch) => watch.deadlineAt)
      .filter(Boolean)
      .sort()[0] || null,
    lastWatchPollAt: new Date(nowMs).toISOString(),
  };
  atomicWriteJson(statePath, state);

  return {
    done: false,
    reason: verification.status,
    verificationStatus: verification.status,
    nextPollAtMs: currentNextPollMs(state),
    state,
  };
}

export async function runEvidenceWatchLoop({
  repoRoot,
  statePath,
  contractPath,
  expectedBinding,
} = {}) {
  while (true) {
    const cycle = runEvidenceWatchCycle({
      repoRoot,
      statePath,
      contractPath,
      expectedBinding,
      nowMs: Date.now(),
    });
    if (cycle.done) return cycle;

    const delay = Math.max(1000, Math.min(
      120000,
      Number(cycle.nextPollAtMs || Date.now() + 15000) - Date.now()
    ));
    await sleep(delay);
  }
}

function clearOwnLock(repoRoot) {
  const lock = lockPath(repoRoot);
  const current = readJson(lock, null);
  if (current?.pid === process.pid) rmSync(lock, { force: true });
}

async function cliMain() {
  if (process.argv[2] !== "--run-watch") return false;
  let input = null;
  try {
    input = JSON.parse(
      Buffer.from(String(process.argv[3] || ""), "base64url").toString("utf8")
    );
    await runEvidenceWatchLoop(input);
    process.exitCode = 0;
  } catch {
    process.exitCode = 2;
  } finally {
    if (input?.repoRoot) clearOwnLock(resolve(input.repoRoot));
  }
  return true;
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invoked === import.meta.url) {
  await cliMain();
}
