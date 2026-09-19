import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  explainEvidenceContract,
} from "../.codex/astra-orchestra/evidence-contract.mjs";
import {
  formatEvidenceInspection,
  inspectProjectEvidence,
} from "../.codex/astra-orchestra/evidence-inspector.mjs";

const COMMAND = "node --test tests/catalog.test.mjs";

function makeState(overrides = {}) {
  return {
    taskId: "task-current",
    conversationId: "parent",
    state: "EXECUTING",
    acceptanceState: "PENDING",
    attempt: 0,
    mutationSeq: 2,
    evidenceCandidateHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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

function factualEvidence(overrides = {}) {
  return {
    evidenceId: "valid-1",
    executionId: "exec-valid-1",
    type: "TEST_RUN",
    command: COMMAND,
    exitCode: 0,
    failed: 0,
    mutationSeq: 2,
    actorRole: "WORKER",
    confidence: "HIGH",
    evidenceSource: "RUNTIME_IDENTITY",
    delegationKind: "WORK",
    producer: {
      actorId: "child",
      role: "WORKER",
      delegationKind: "WORK",
      confidence: "HIGH",
      source: "RUNTIME_IDENTITY",
      parentConversationId: "parent",
    },
    binding: {
      taskId: "task-current",
      attempt: 0,
      mutationSeq: 2,
      commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    ...overrides,
  };
}

test("evidence observability: explains rejected candidates without hiding a valid one", () => {
  const state = makeState({
    evidenceLedger: [
      factualEvidence({
        evidenceId: "other-task",
        executionId: "exec-other-task",
        binding: {
          taskId: "task-old",
          attempt: 0,
          mutationSeq: 2,
          commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      }),
      factualEvidence({
        evidenceId: "old-commit",
        executionId: "exec-old-commit",
        binding: {
          taskId: "task-current",
          attempt: 0,
          mutationSeq: 2,
          commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      }),
      factualEvidence({
        evidenceId: "model-claim",
        executionId: "exec-model-claim",
        evidenceSource: "MODEL_CLAIM",
        producer: {
          actorId: "fake",
          role: "WORKER",
          delegationKind: "WORK",
          confidence: "HIGH",
          source: "MODEL_CLAIM",
          parentConversationId: "parent",
        },
      }),
      factualEvidence(),
    ],
  });

  const report = explainEvidenceContract({ activeState: state });
  assert.equal(report.status, "SATISFIED");
  assert.equal(report.verified, true);
  assert.equal(report.requirements.length, 1);

  const req = report.requirements[0];
  assert.equal(req.selectedEvidenceId, "valid-1");
  assert.equal(req.candidateCount, 4);

  const byId = new Map(req.candidates.map((candidate) => [candidate.evidenceId, candidate]));
  assert.equal(byId.get("valid-1").status, "SATISFIED");
  assert.equal(byId.get("other-task").reason, "TASK_ID_MISMATCH");
  assert.equal(byId.get("old-commit").reason, "COMMIT_SHA_MISMATCH");
  assert.equal(byId.get("model-claim").reason, "LOCAL_EVIDENCE_PRODUCER_NOT_AUTHORIZED");
});

test("evidence observability: missing evidence explains the requirement rather than inventing proof", () => {
  const state = makeState();
  const report = explainEvidenceContract({ activeState: state });
  assert.equal(report.status, "MISSING_ACTIONABLE");
  assert.equal(report.requirements[0].reason, "LOCAL_COMMAND_NOT_EXECUTED");
  assert.equal(report.requirements[0].candidateCount, 0);
});

test("evidence observability: project inspector is read-only and reports current git HEAD", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-evidence-inspector-"));
  try {
    execFileSync("git", ["init", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Orchestra Tests"]);
    execFileSync("git", ["-C", root, "config", "user.email", "orchestra@example.invalid"]);
    writeFileSync(join(root, "tracked.txt"), "base\n");
    execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    execFileSync("git", ["-C", root, "commit", "-m", "base"]);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    mkdirSync(join(root, ".codex", "orchestra-state"), { recursive: true });
    const state = makeState({
      evidenceCandidateHead: undefined,
      evidenceLedger: [factualEvidence({
        binding: {
          taskId: "task-current",
          attempt: 0,
          mutationSeq: 2,
          commitSha: head,
        },
      })],
      lastStopBlockedReason: "EVIDENCE_MISSING",
      stopBlockedCount: 1,
    });
    writeFileSync(join(root, ".codex", "orchestra-state", "active-state.json"), JSON.stringify(state, null, 2));
    writeFileSync(join(root, ".codex", "orchestra-state", "active-contract.json"), JSON.stringify(state.scopeContract, null, 2));

    const before = JSON.stringify(state);
    const report = inspectProjectEvidence(root);
    const after = JSON.stringify(JSON.parse(
      requireRead(join(root, ".codex", "orchestra-state", "active-state.json"))
    ));

    assert.equal(report.available, true);
    assert.equal(report.task.candidateHead, head);
    assert.equal(report.status, "SATISFIED");
    assert.equal(report.runtimeSignals.lastStopBlockedReason, "EVIDENCE_MISSING");
    assert.equal(after, before);

    const output = formatEvidenceInspection(report);
    assert.match(output, /Orchestra Codex Evidence Status/);
    assert.match(output, /SATISFIED/);
    assert.match(output, /producer=WORKER/);
    assert.match(output, /Stop Guard: EVIDENCE_MISSING/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function requireRead(path) {
  return execFileSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))", path], {
    encoding: "utf8",
  });
}

test("evidence observability: no active state is explicit and non-fabricated", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-evidence-empty-"));
  try {
    const report = inspectProjectEvidence(root);
    assert.equal(report.available, false);
    assert.equal(report.status, "NO_ACTIVE_STATE");
    assert.equal(report.evidence, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
