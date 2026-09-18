import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  finalizeEvidenceRecord,
  normalizeEvidenceRequirements,
} from "../../runtimes/antigravity/.agents/skills/orchestra/evidence-contract.mjs";
import {
  collectRuntimeEvidenceSync,
} from "../../runtimes/antigravity/.agents/skills/orchestra/evidence-collectors.mjs";
import {
  getEvidenceProvider,
  listEvidenceProviders,
  validateRemoteEvidenceRequirement,
} from "../../runtimes/antigravity/.agents/skills/orchestra/evidence-provider-registry.mjs";
import {
  ensureEvidenceWatch,
  noteEvidenceWatchResult,
  shouldPollEvidenceWatch,
  summarizeEvidenceWatches,
} from "../../runtimes/antigravity/.agents/skills/orchestra/evidence-watch.mjs";
import {
  runEvidenceWatchCycle,
} from "../../runtimes/antigravity/.agents/skills/orchestra/evidence-watch-runner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const orchestraRoot = resolve(__dirname, "../..");
const stopScript = resolve(orchestraRoot, "runtimes/antigravity/.agents/hooks/stop-guard.mjs");

const REQUIREMENT = Object.freeze({
  id: "fast-ci",
  class: "FAST_CI",
  kind: "REMOTE_CI",
  provider: "GITHUB_ACTIONS",
  repository: "CURRENT_ORIGIN",
  workflow: { name: "Fast CI" },
  requiredJobs: ["Format", "Unit Tests"],
  watchPolicy: {
    initialBackoffMs: 1000,
    maxBackoffMs: 4000,
    timeoutMs: 10000,
  },
});

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-provider-watch-"));
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Orchestra Tests"]);
  execFileSync("git", ["-C", root, "config", "user.email", "orchestra@example.invalid"]);
  writeFileSync(join(root, "tracked.txt"), "base\n");
  execFileSync("git", ["-C", root, "add", "tracked.txt"]);
  execFileSync("git", ["-C", root, "commit", "-m", "base"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/jssantogit/mihon.git"]);
  return root;
}

function head(root) {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function pendingRecord(root, state, overrides = {}) {
  return finalizeEvidenceRecord({
    evidenceId: "pending-fast-ci",
    requirementId: "fast-ci",
    class: "FAST_CI",
    kind: "REMOTE_CI",
    result: "PENDING",
    reason: "CI_RUN_IN_PROGRESS",
    provider: "GITHUB_ACTIONS",
    repository: "jssantogit/mihon",
    workflow: { name: "Fast CI" },
    run: {
      id: 12345,
      attempt: 1,
      headSha: head(root),
      headBranch: "main",
      status: "in_progress",
      conclusion: null,
    },
    jobs: [],
    binding: {
      taskId: state.taskId,
      attempt: state.attempt,
      mutationSeq: state.mutationSeq,
      commitSha: head(root),
      branch: "main",
    },
    provenance: {
      source: "ORCHESTRA_GITHUB_COLLECTOR",
      observedAt: new Date().toISOString(),
    },
    ...overrides,
  });
}

function baseState(root, overrides = {}) {
  return {
    activeRole: "ORCHESTRATOR",
    conversationId: "parent-watch",
    state: "EXECUTING",
    taskAction: "IMPLEMENT",
    taskDomain: "CODE",
    criticality: "NORMAL",
    taskId: "watch-task",
    attempt: 0,
    mutationSeq: 1,
    evidenceCandidateHead: head(root),
    acceptanceState: "PENDING",
    workerWorkspaceWrites: 1,
    orchestratorWorkspaceWrites: 0,
    unknownWorkspaceWrites: 0,
    workerCompletionClaimed: true,
    workerCompletionClaimFactual: true,
    implementationComplete: true,
    workerCompletionClaimIdentity: {
      actorId: "child-watch",
      source: "RUNTIME_IDENTITY",
      confidence: "HIGH",
      delegationKind: "WORK",
      attempt: 0,
    },
    scopeContract: {
      allowedPaths: ["tracked.txt"],
      forbiddenPaths: [".agents/**"],
      testsRequired: [],
      requiredEvidence: [structuredClone(REQUIREMENT)],
    },
    evidenceLedger: [],
    ...overrides,
  };
}

test("provider registry: REMOTE_CI validation is provider-driven", () => {
  const provider = getEvidenceProvider("github_actions");
  assert.equal(provider.id, "GITHUB_ACTIONS");
  assert.equal(provider.supportsWatch, true);
  assert.equal(listEvidenceProviders().length >= 1, true);

  const valid = validateRemoteEvidenceRequirement(REQUIREMENT);
  assert.equal(valid.valid, true);
  assert.equal(valid.provider, "GITHUB_ACTIONS");

  const unsupported = validateRemoteEvidenceRequirement({
    ...REQUIREMENT,
    provider: "UNKNOWN_CI",
  });
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.reason, "REMOTE_CI_PROVIDER_UNSUPPORTED");

  const normalized = normalizeEvidenceRequirements({
    requiredEvidence: [REQUIREMENT],
    testsRequired: [],
  });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.requirements[0].provider, "GITHUB_ACTIONS");
});

test("evidence watch: pending result creates deterministic backoff and avoids early poll", () => {
  const state = {
    taskId: "watch-task",
    attempt: 0,
    mutationSeq: 1,
    evidenceCandidateHead: "abc",
  };
  const watch = ensureEvidenceWatch(state, REQUIREMENT, 10000);
  assert.equal(watch.status, "READY_TO_POLL");

  noteEvidenceWatchResult(state, REQUIREMENT, {
    evidenceId: "pending",
    result: "PENDING",
    reason: "CI_RUN_IN_PROGRESS",
  }, 10000);

  const summary = summarizeEvidenceWatches(state);
  assert.equal(summary.pending, 1);
  assert.equal(summary.watches[0].pollCount, 1);

  const early = shouldPollEvidenceWatch(state, REQUIREMENT, 10500);
  assert.equal(early.poll, false);
  assert.equal(early.reason, "WATCH_BACKOFF");

  const due = shouldPollEvidenceWatch(state, REQUIREMENT, 11000);
  assert.equal(due.poll, true);
});

test("evidence watch: binding change creates a new watch instead of reusing stale task state", () => {
  const state = {
    taskId: "task-a",
    attempt: 0,
    mutationSeq: 1,
    evidenceCandidateHead: "aaa",
  };
  const first = ensureEvidenceWatch(state, REQUIREMENT, 1000);
  noteEvidenceWatchResult(state, REQUIREMENT, { result: "PENDING" }, 1000);

  state.taskId = "task-b";
  state.evidenceCandidateHead = "bbb";
  const second = ensureEvidenceWatch(state, REQUIREMENT, 2000);

  assert.notEqual(second.startedAtMs, first.startedAtMs);
  assert.equal(second.binding.taskId, "task-b");
  assert.equal(second.pollCount, 0);
});

test("collector: persisted backoff skips remote provider without spawning a probe", () => {
  const root = initRepo();
  try {
    const state = baseState(root);
    const pending = pendingRecord(root, state);
    state.evidenceLedger = [pending];

    ensureEvidenceWatch(state, REQUIREMENT, 10000);
    noteEvidenceWatchResult(state, REQUIREMENT, pending, 10000);

    const result = collectRuntimeEvidenceSync({
      repoRoot: root,
      activeState: state,
      contract: state.scopeContract,
      nowMs: 10500,
    });

    assert.equal(result.remotePollPerformed, false);
    assert.equal(result.records.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, "WATCH_BACKOFF");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watch runner: timeout moves only to EVIDENCE_READY and never accepts the task", () => {
  const root = initRepo();
  try {
    mkdirSync(join(root, ".agents", "state"), { recursive: true });
    const timedRequirement = {
      ...structuredClone(REQUIREMENT),
      watchPolicy: {
        initialBackoffMs: 1000,
        maxBackoffMs: 1000,
        timeoutMs: 1000,
      },
    };
    const state = baseState(root, {
      state: "CI_WAIT",
      scopeContract: {
        allowedPaths: ["tracked.txt"],
        forbiddenPaths: [".agents/**"],
        testsRequired: [],
        requiredEvidence: [timedRequirement],
      },
    });
    const pending = pendingRecord(root, state);
    state.evidenceLedger = [pending];
    ensureEvidenceWatch(state, timedRequirement, 10000);
    noteEvidenceWatchResult(state, timedRequirement, pending, 10000);

    const statePath = join(root, ".agents", "state", "active-state.json");
    const contractPath = join(root, ".agents", "state", "active-contract.json");
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    writeFileSync(contractPath, JSON.stringify(state.scopeContract, null, 2));

    const cycle = runEvidenceWatchCycle({
      repoRoot: root,
      statePath,
      contractPath,
      expectedBinding: { taskId: state.taskId, attempt: 0, mutationSeq: 1 },
      nowMs: 12000,
    });

    assert.equal(cycle.done, true);
    assert.equal(cycle.verificationStatus, "SOURCE_UNAVAILABLE");
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(after.state, "EVIDENCE_READY");
    assert.notEqual(after.acceptanceState, "ACCEPTED");
    assert.equal(after.evidenceWatches["fast-ci"].status, "TIMED_OUT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop Guard: CI_WAIT stops the model turn and persists disabled-runner metadata", () => {
  const root = initRepo();
  try {
    mkdirSync(join(root, ".agents", "state"), { recursive: true });
    const state = baseState(root);
    const pending = pendingRecord(root, state);
    state.evidenceLedger = [pending];
    ensureEvidenceWatch(state, REQUIREMENT, Date.now());
    noteEvidenceWatchResult(state, REQUIREMENT, pending, Date.now());

    writeFileSync(join(root, ".agents", "state", "active-state.json"), JSON.stringify(state, null, 2));
    writeFileSync(join(root, ".agents", "state", "active-contract.json"), JSON.stringify(state.scopeContract, null, 2));
    writeFileSync(join(root, ".agents", "state", "role-bindings.json"), JSON.stringify({
      mainConversationId: "parent-watch",
      bindings: {
        "parent-watch": {
          conversationId: "parent-watch",
          role: "ORCHESTRATOR",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
        },
        "child-watch": {
          conversationId: "child-watch",
          parentConversationId: "parent-watch",
          role: "WORKER",
          profile: "flash-medium-worker",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
          delegationKind: "WORK",
          taskIdentifier: state.taskId,
          attempt: 0,
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2));

    const output = execFileSync(process.execPath, [stopScript], {
      input: JSON.stringify({
        workspacePaths: [root],
        conversationId: "parent-watch",
        taskId: state.taskId,
        fullyIdle: true,
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        ORCHESTRA_DISABLE_BACKGROUND_EVIDENCE_WATCH: "1",
      },
    });
    const decision = JSON.parse(output);
    assert.equal(decision.decision, "stop");
    assert.match(decision.reason, /CI_WAIT/);

    const after = JSON.parse(
      readFileSync(join(root, ".agents", "state", "active-state.json"), "utf8")
    );
    assert.equal(after.state, "CI_WAIT");
    assert.equal(after.ciWait.runner.disabled, true);
    assert.equal(after.evidenceSourceUnavailableCount || 0, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
