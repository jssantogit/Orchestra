import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  verifyEvidenceContract,
} from "../../runtimes/antigravity/.agents/skills/orchestra/evidence-contract.mjs";
import {
  bindLocalEvidence,
  federateDelegatedEvidence,
  finalizeActiveTaskEvidenceBindings,
} from "../../runtimes/antigravity/.agents/skills/orchestra/evidence-federation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const stopScript = resolve(root, "runtimes/antigravity/.agents/hooks/stop-guard.mjs");

const COMMAND = "node --test tests/catalog.test.mjs";

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "orchestra-fed-evidence-"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Orchestra Tests"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "orchestra@example.invalid"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  return repo;
}

function head(repo) {
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function state(overrides = {}) {
  return {
    taskId: "task-current",
    conversationId: "parent-conv",
    attempt: 0,
    mutationSeq: 3,
    scopeContract: {
      testsRequired: [],
      requiredEvidence: [{
        id: "local-validation",
        class: "LOCAL_TEST",
        kind: "LOCAL_COMMAND",
        command: COMMAND,
      }],
    },
    evidenceLedger: [],
    ...overrides,
  };
}

function provisionalWorkerEvidence(repo, activeState, overrides = {}) {
  return bindLocalEvidence({
    evidence: {
      evidenceId: "exec-child-1",
      executionId: "exec-child-1",
      type: "TEST_RUN",
      command: COMMAND,
      exitCode: 0,
      mutationSeq: activeState.mutationSeq,
      timestamp: new Date().toISOString(),
      ...overrides,
    },
    activeState,
    actor: {
      role: "WORKER",
      actorId: "child-conv",
      confidence: "MEDIUM",
      source: "HOOK_PAYLOAD_CORRELATION",
      delegationKind: "WORK",
      attempt: activeState.attempt,
    },
    repoRoot: repo,
    conversationId: "child-conv",
    parentConversationId: "parent-conv",
  });
}

test("federation: factual delegated worker evidence satisfies parent acceptance", () => {
  const repo = initRepo();
  try {
    const active = state();
    active.evidenceLedger.push(provisionalWorkerEvidence(repo, active));

    const before = verifyEvidenceContract({ activeState: active });
    assert.equal(before.verified, false);

    const promoted = federateDelegatedEvidence({
      activeState: active,
      factualBinding: {
        role: "WORKER",
        confidence: "HIGH",
        source: "RUNTIME_IDENTITY",
        delegationKind: "WORK",
        taskIdentifier: active.taskId,
        attempt: active.attempt,
        parentConversationId: "parent-conv",
      },
      childConversationId: "child-conv",
      parentConversationId: "parent-conv",
      repoRoot: repo,
    });
    assert.equal(promoted.promoted, 1);

    finalizeActiveTaskEvidenceBindings({ activeState: active, repoRoot: repo });
    const after = verifyEvidenceContract({ activeState: active });
    assert.equal(after.status, "SATISFIED");
    assert.equal(after.verified, true);
    assert.equal(after.evidence.producer.source, "RUNTIME_IDENTITY");
    assert.equal(after.evidence.binding.taskId, "task-current");
    assert.equal(after.evidence.binding.commitSha, head(repo));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("federation: dedicated validation worker is an authorized factual producer", () => {
  const repo = initRepo();
  try {
    const active = state();
    active.evidenceLedger.push(provisionalWorkerEvidence(repo, active));

    const promoted = federateDelegatedEvidence({
      activeState: active,
      factualBinding: {
        role: "WORKER",
        confidence: "HIGH",
        source: "RUNTIME_IDENTITY",
        delegationKind: "VALIDATION",
        taskIdentifier: active.taskId,
        attempt: active.attempt,
        parentConversationId: "parent-conv",
      },
      childConversationId: "child-conv",
      parentConversationId: "parent-conv",
      repoRoot: repo,
    });
    assert.equal(promoted.promoted, 1);

    finalizeActiveTaskEvidenceBindings({ activeState: active, repoRoot: repo });
    const result = verifyEvidenceContract({ activeState: active });
    assert.equal(result.status, "SATISFIED");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("federation: evidence from another task never satisfies current parent", () => {
  const repo = initRepo();
  try {
    const oldState = state({ taskId: "task-old" });
    const ev = bindLocalEvidence({
      evidence: {
        evidenceId: "old-task-evidence",
        type: "TEST_RUN",
        command: COMMAND,
        exitCode: 0,
        mutationSeq: 3,
      },
      activeState: oldState,
      actor: {
        role: "WORKER",
        actorId: "old-child",
        confidence: "HIGH",
        source: "RUNTIME_IDENTITY",
        delegationKind: "WORK",
        attempt: 0,
      },
      repoRoot: repo,
      conversationId: "old-child",
      parentConversationId: "parent-conv",
    });

    const current = state({ evidenceLedger: [ev] });
    current.evidenceCandidateHead = head(repo);
    const result = verifyEvidenceContract({ activeState: current });
    assert.equal(result.verified, false);
    assert.equal(result.status, "STALE");
    assert.equal(result.results[0].reason, "TASK_ID_MISMATCH");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("federation: evidence bound to an old concrete commit is stale", () => {
  const repo = initRepo();
  try {
    const active = state();
    const ev = bindLocalEvidence({
      evidence: {
        evidenceId: "old-commit-evidence",
        type: "TEST_RUN",
        command: COMMAND,
        exitCode: 0,
        mutationSeq: 3,
      },
      activeState: active,
      actor: {
        role: "WORKER",
        actorId: "child-conv",
        confidence: "HIGH",
        source: "RUNTIME_IDENTITY",
        delegationKind: "WORK",
        attempt: 0,
      },
      repoRoot: repo,
      conversationId: "child-conv",
      parentConversationId: "parent-conv",
    });
    const oldHead = ev.binding.commitSha;

    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "new-head"]);
    assert.notEqual(head(repo), oldHead);

    active.evidenceLedger = [ev];
    finalizeActiveTaskEvidenceBindings({ activeState: active, repoRoot: repo });
    const result = verifyEvidenceContract({ activeState: active });
    assert.equal(result.status, "STALE");
    assert.equal(result.results[0].reason, "COMMIT_SHA_MISMATCH");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("federation: failed factual validation does not satisfy acceptance", () => {
  const repo = initRepo();
  try {
    const active = state();
    const ev = bindLocalEvidence({
      evidence: {
        evidenceId: "failed-validation",
        type: "TEST_RUN",
        command: COMMAND,
        exitCode: 1,
        mutationSeq: 3,
      },
      activeState: active,
      actor: {
        role: "WORKER",
        actorId: "child-conv",
        confidence: "HIGH",
        source: "RUNTIME_IDENTITY",
        delegationKind: "WORK",
        attempt: 0,
      },
      repoRoot: repo,
      conversationId: "child-conv",
      parentConversationId: "parent-conv",
    });
    active.evidenceLedger = [ev];
    finalizeActiveTaskEvidenceBindings({ activeState: active, repoRoot: repo });

    const result = verifyEvidenceContract({ activeState: active });
    assert.equal(result.status, "FAILED");
    assert.equal(result.verified, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("federation: pure model claim cannot satisfy local evidence", () => {
  const repo = initRepo();
  try {
    const active = state();
    active.evidenceCandidateHead = head(repo);
    active.evidenceLedger = [{
      evidenceId: "model-claim",
      type: "TEST_RUN",
      command: COMMAND,
      exitCode: 0,
      mutationSeq: 3,
      actorRole: "WORKER",
      confidence: "HIGH",
      evidenceSource: "MODEL_CLAIM",
      delegationKind: "WORK",
      binding: {
        taskId: active.taskId,
        attempt: 0,
        mutationSeq: 3,
        commitSha: head(repo),
      },
      producer: {
        actorId: "fake",
        role: "WORKER",
        confidence: "HIGH",
        source: "MODEL_CLAIM",
        delegationKind: "WORK",
        parentConversationId: "parent-conv",
      },
    }];

    const result = verifyEvidenceContract({ activeState: active });
    assert.equal(result.verified, false);
    assert.equal(result.status, "MISSING_ACTIONABLE");
    assert.equal(result.results[0].reason, "LOCAL_EVIDENCE_PRODUCER_NOT_AUTHORIZED");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("federation: factual parent-local validation remains valid", () => {
  const repo = initRepo();
  try {
    const active = state();
    const ev = bindLocalEvidence({
      evidence: {
        evidenceId: "parent-local-validation",
        type: "TEST_RUN",
        command: COMMAND,
        exitCode: 0,
        mutationSeq: 3,
      },
      activeState: active,
      actor: {
        role: "ORCHESTRATOR",
        actorId: "parent-conv",
        confidence: "HIGH",
        source: "CONVERSATION_BOUND_IDENTITY",
        delegationKind: null,
        attempt: 0,
      },
      repoRoot: repo,
      conversationId: "parent-conv",
      parentConversationId: "parent-conv",
    });
    active.evidenceLedger = [ev];
    finalizeActiveTaskEvidenceBindings({ activeState: active, repoRoot: repo });

    const result = verifyEvidenceContract({ activeState: active });
    assert.equal(result.status, "SATISFIED");
    assert.equal(result.verified, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("federation: real absence still escalates Stop Guard to HUMAN_GATE", () => {
  const repo = initRepo();
  try {
    mkdirSync(join(repo, ".agents", "state"), { recursive: true });
    const active = state({
      state: "EXECUTING",
      acceptanceState: "PENDING",
      workerCompletionClaimed: true,
      workerCompletionClaimFactual: true,
      implementationComplete: true,
      workerCompletionClaimIdentity: {
        actorId: "impl-child",
        source: "RUNTIME_IDENTITY",
        confidence: "HIGH",
        delegationKind: "WORK",
        attempt: 0,
      },
    });
    writeFileSync(join(repo, ".agents", "state", "active-state.json"), JSON.stringify(active, null, 2));
    writeFileSync(join(repo, ".agents", "state", "active-contract.json"), JSON.stringify(active.scopeContract, null, 2));
    writeFileSync(join(repo, ".agents", "state", "role-bindings.json"), JSON.stringify({
      mainConversationId: "parent-conv",
      bindings: {
        "parent-conv": {
          conversationId: "parent-conv",
          role: "ORCHESTRATOR",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2));

    const input = JSON.stringify({
      workspacePaths: [repo],
      conversationId: "parent-conv",
      taskId: active.taskId,
      fullyIdle: true,
    });
    const first = JSON.parse(execFileSync(process.execPath, [stopScript], { input, encoding: "utf8" }));
    assert.equal(first.decision, "continue");
    assert.match(first.reason, /EVIDENCE_MISSING/);

    const second = JSON.parse(execFileSync(process.execPath, [stopScript], { input, encoding: "utf8" }));
    assert.equal(second.decision, "continue");
    assert.match(second.reason, /STOP_GUARD_STALLED/);

    const finalState = JSON.parse(readFileSync(join(repo, ".agents", "state", "active-state.json"), "utf8"));
    assert.equal(finalState.state, "HUMAN_GATE");
    assert.equal(finalState.circuitBreakerType, "STOP_GUARD_STALLED");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
