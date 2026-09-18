import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  childOwnedMissingRequirements,
  finalizeEvidenceRecord,
  normalizeEvidenceRequirements,
  verifyEvidenceContract,
} from "../../runtimes/antigravity/.agents/skills/orchestra/evidence-contract.mjs";
import {
  collectLocalFactRequirement,
  parseGitHubRepository,
  validateGitHubActionsPayload,
} from "../../runtimes/antigravity/.agents/skills/orchestra/evidence-collectors.mjs";
import {
  RETRY_REASONS,
  STATE_NAMES,
  classifyExecutionEvidence,
  isValidationCommand,
  validateStateTransition,
} from "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const orchestraRoot = resolve(__dirname, "../..");
const preToolScript = resolve(
  orchestraRoot,
  "runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs",
);
const stopScript = resolve(
  orchestraRoot,
  "runtimes/antigravity/.agents/hooks/stop-guard.mjs",
);

const FAST_CI_REQUIREMENT = Object.freeze({
  id: "fast-ci",
  class: "FAST_CI",
  kind: "REMOTE_CI",
  provider: "GITHUB_ACTIONS",
  repository: "CURRENT_ORIGIN",
  workflow: {
    id: 360365122,
    name: "Fast CI",
    path: ".github/workflows/ci.yml",
  },
  requiredJobs: [
    "Format",
    "Kotlin Compile",
    "Unit Tests",
    "SQLDelight Migrations",
  ],
});

const TASK_1_RUN = Object.freeze({
  id: 35366248028,
  workflow_id: 360365122,
  name: "Fast CI",
  path: ".github/workflows/ci.yml",
  head_sha: "754fd787e8e736a2a636b40fbb7e78bf3121dfd4",
  head_branch: "tsuzuki/mvp-v1-catalog-kitsu-search-discover",
  status: "completed",
  conclusion: "success",
  event: "push",
  run_attempt: 1,
  repository: { full_name: "jssantogit/mihon" },
});

const TASK_1_JOBS = Object.freeze([
  { id: 105669321160, name: "Kotlin Compile", status: "completed", conclusion: "success", head_sha: TASK_1_RUN.head_sha },
  { id: 105669321375, name: "SQLDelight Migrations", status: "completed", conclusion: "success", head_sha: TASK_1_RUN.head_sha },
  { id: 105669321460, name: "Format", status: "completed", conclusion: "success", head_sha: TASK_1_RUN.head_sha },
  { id: 105669321656, name: "Unit Tests", status: "completed", conclusion: "success", head_sha: TASK_1_RUN.head_sha },
]);

const TASK_2_RUN = Object.freeze({
  id: 35368076713,
  workflow_id: 360365122,
  name: "Fast CI",
  path: ".github/workflows/ci.yml",
  head_sha: "da380a41ddf36718ab47022d26446d3206d65af3",
  head_branch: "tsuzuki/mvp-v1-catalog-kitsu-search-discover",
  status: "completed",
  conclusion: "success",
  event: "push",
  run_attempt: 1,
  repository: { full_name: "jssantogit/mihon" },
});

const TASK_2_JOBS = Object.freeze([
  {
    id: 105675246081,
    name: "SQLDelight Migrations",
    status: "completed",
    conclusion: "success",
    head_sha: "da380a41ddf36718ab47022d26446d3206d65af3",
  },
  {
    id: 105675246280,
    name: "Unit Tests",
    status: "completed",
    conclusion: "success",
    head_sha: "da380a41ddf36718ab47022d26446d3206d65af3",
  },
  {
    id: 105675246381,
    name: "Format",
    status: "completed",
    conclusion: "success",
    head_sha: "da380a41ddf36718ab47022d26446d3206d65af3",
  },
  {
    id: 105675246442,
    name: "Kotlin Compile",
    status: "completed",
    conclusion: "success",
    head_sha: "da380a41ddf36718ab47022d26446d3206d65af3",
  },
]);

function taskState(overrides = {}) {
  return {
    taskId: "tsuzuki-task-2",
    attempt: 0,
    mutationSeq: 7,
    scopeContract: {
      testsRequired: [],
      requiredEvidence: [structuredClone(FAST_CI_REQUIREMENT)],
    },
    evidenceLedger: [],
    ...overrides,
  };
}

function factualGit(overrides = {}) {
  return {
    ok: true,
    repository: "jssantogit/mihon",
    originUrl: "https://github.com/jssantogit/mihon.git",
    headSha: "da380a41ddf36718ab47022d26446d3206d65af3",
    branch: "tsuzuki/mvp-v1-catalog-kitsu-search-discover",
    trackedDirty: false,
    trackedStatus: "",
    ...overrides,
  };
}

function providerRecord(result = "PASS", overrides = {}) {
  const state = taskState();
  return finalizeEvidenceRecord({
    evidenceId: "evidence-fast-ci-task-2",
    requirementId: "fast-ci",
    class: "FAST_CI",
    kind: "REMOTE_CI",
    result,
    reason: null,
    provider: "GITHUB_ACTIONS",
    repository: "jssantogit/mihon",
    workflow: {
      id: 360365122,
      name: "Fast CI",
      path: ".github/workflows/ci.yml",
    },
    run: {
      id: 35368076713,
      attempt: 1,
      headSha: factualGit().headSha,
      headBranch: factualGit().branch,
      status: "completed",
      conclusion: "success",
    },
    jobs: TASK_2_JOBS.map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      headSha: job.head_sha,
    })),
    binding: {
      taskId: state.taskId,
      attempt: 0,
      commitSha: factualGit().headSha,
      branch: factualGit().branch,
      mutationSeq: 7,
    },
    provenance: {
      source: "ORCHESTRA_GITHUB_COLLECTOR",
      observedAt: "2026-09-18T16:30:00.000Z",
    },
    ...overrides,
  });
}

function initGitRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-evidence-"));
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Orchestra Tests"]);
  execFileSync("git", ["-C", root, "config", "user.email", "orchestra@example.invalid"]);
  writeFileSync(join(root, ".gitignore"), ".agents/\nGEMINI.md\n", "utf8");
  writeFileSync(join(root, "tracked.txt"), "base\n", "utf8");
  execFileSync("git", ["-C", root, "add", ".gitignore", "tracked.txt"]);
  execFileSync("git", ["-C", root, "commit", "-m", "fixture"]);
  return root;
}

test("evidence: CI-first contract explicitly clears local tests", () => {
  const normalized = normalizeEvidenceRequirements({
    testsRequired: [],
    requiredEvidence: [FAST_CI_REQUIREMENT],
  });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.requirements.length, 1);
  assert.equal(normalized.requirements[0].id, "fast-ci");
  assert.equal(normalized.requirements[0].kind, "REMOTE_CI");
});

test("evidence: verified provider record satisfies CI-first acceptance without local Gradle", () => {
  const state = taskState({ evidenceLedger: [providerRecord()] });
  const result = verifyEvidenceContract({ activeState: state });
  assert.equal(result.status, "SATISFIED");
  assert.equal(result.verified, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].evidence.provider, "GITHUB_ACTIONS");
});

test("evidence: model-authored CI claim cannot satisfy provider evidence", () => {
  const state = taskState({
    evidenceLedger: [{
      requirementId: "fast-ci",
      class: "FAST_CI",
      kind: "REMOTE_CI",
      result: "PASS",
      provider: "GITHUB_ACTIONS",
      binding: { attempt: 0, mutationSeq: 7 },
      provenance: { source: "MODEL_CLAIM" },
    }],
  });
  const result = verifyEvidenceContract({ activeState: state });
  assert.equal(result.verified, false);
  assert.equal(result.status, "STALE");
});

test("evidence: provider evidence from previous mutation is stale", () => {
  const stale = providerRecord("PASS", {
    binding: {
      taskId: "tsuzuki-task-2",
      attempt: 0,
      commitSha: factualGit().headSha,
      branch: factualGit().branch,
      mutationSeq: 6,
    },
  });
  const result = verifyEvidenceContract({
    activeState: taskState({ evidenceLedger: [stale] }),
  });
  assert.equal(result.status, "STALE");
  assert.equal(result.verified, false);
  assert.equal(result.results[0].reason, "MUTATION_SEQ_MISMATCH");
});

test("evidence: Tsuzuki Task 1 Fast CI run is first-class evidence for its exact commit", () => {
  const verdict = validateGitHubActionsPayload({
    requirement: FAST_CI_REQUIREMENT,
    run: TASK_1_RUN,
    jobs: TASK_1_JOBS,
    factual: factualGit({
      headSha: TASK_1_RUN.head_sha,
      branch: TASK_1_RUN.head_branch,
    }),
  });
  assert.equal(verdict.result, "PASS");
  assert.equal(verdict.reason, null);
});

test("evidence: real Tsuzuki Fast CI fixture is accepted only for exact commit and required jobs", () => {
  const ok = validateGitHubActionsPayload({
    requirement: FAST_CI_REQUIREMENT,
    run: TASK_2_RUN,
    jobs: TASK_2_JOBS,
    factual: factualGit(),
  });
  assert.equal(ok.result, "PASS");

  const stale = validateGitHubActionsPayload({
    requirement: FAST_CI_REQUIREMENT,
    run: TASK_2_RUN,
    jobs: TASK_2_JOBS,
    factual: factualGit({ headSha: "754fd787e8e736a2a636b40fbb7e78bf3121dfd4" }),
  });
  assert.equal(stale.result, "STALE");
  assert.equal(stale.reason, "CI_COMMIT_MISMATCH");

  const missing = validateGitHubActionsPayload({
    requirement: FAST_CI_REQUIREMENT,
    run: TASK_2_RUN,
    jobs: TASK_2_JOBS.filter((job) => job.name !== "Unit Tests"),
    factual: factualGit(),
  });
  assert.equal(missing.result, "FAIL");
  assert.equal(missing.reason, "CI_REQUIRED_JOBS_MISSING");

  const failed = validateGitHubActionsPayload({
    requirement: FAST_CI_REQUIREMENT,
    run: { ...TASK_2_RUN, conclusion: "failure" },
    jobs: TASK_2_JOBS.map((job) => (
      job.name === "Unit Tests" ? { ...job, conclusion: "failure" } : job
    )),
    factual: factualGit(),
  });
  assert.equal(failed.result, "FAIL");
  assert.equal(failed.reason, "CI_REQUIRED_JOB_FAILED");
});

test("evidence: running CI is PENDING, not EVIDENCE_MISSING", () => {
  const pending = validateGitHubActionsPayload({
    requirement: FAST_CI_REQUIREMENT,
    run: { ...TASK_2_RUN, status: "in_progress", conclusion: null },
    jobs: TASK_2_JOBS.map((job) => ({ ...job, status: "in_progress", conclusion: null })),
    factual: factualGit(),
  });
  assert.equal(pending.result, "PENDING");
  assert.match(pending.reason, /^CI_RUN_/);

  const record = providerRecord("PENDING", { reason: pending.reason });
  const result = verifyEvidenceContract({
    activeState: taskState({ evidenceLedger: [record] }),
  });
  assert.equal(result.status, "PENDING");
  assert.equal(result.verified, false);
});

test("evidence: worker-owned local command is actionable and stays with the worker", () => {
  const state = {
    taskId: "mechanical-ignore",
    attempt: 0,
    mutationSeq: 2,
    scopeContract: {
      testsRequired: [],
      requiredEvidence: [{
        id: "ignored-runtime-files",
        class: "LOCAL_COMMAND",
        kind: "LOCAL_COMMAND",
        command: "git check-ignore -v .agents/hooks.json GEMINI.md",
      }],
    },
    evidenceLedger: [],
  };
  const result = verifyEvidenceContract({ activeState: state });
  assert.equal(result.status, "MISSING_ACTIONABLE");
  const childOwned = childOwnedMissingRequirements(result);
  assert.equal(childOwned.length, 1);
  assert.equal(childOwned[0].command, "git check-ignore -v .agents/hooks.json GEMINI.md");
});

test("evidence: WORK child cannot terminate while an actionable local command is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-child-evidence-"));
  try {
    mkdirSync(join(root, ".agents", "state"), { recursive: true });
    const contract = {
      allowedPaths: [".gitignore"],
      forbiddenPaths: [".agents/**"],
      testsRequired: [],
      requiredEvidence: [{
        id: "ignore-check",
        class: "LOCAL_COMMAND",
        kind: "LOCAL_COMMAND",
        command: "git check-ignore -v .agents/hooks.json GEMINI.md",
      }],
    };
    writeFileSync(join(root, ".agents", "state", "active-state.json"), JSON.stringify({
      state: "DELEGATED",
      taskAction: "MECHANICAL_FIX",
      taskId: "ignore-runtime-files",
      attempt: 0,
      mutationSeq: 1,
      scopeContract: contract,
      evidenceLedger: [],
    }, null, 2));
    writeFileSync(join(root, ".agents", "state", "active-contract.json"), JSON.stringify(contract, null, 2));
    writeFileSync(join(root, ".agents", "state", "role-bindings.json"), JSON.stringify({
      mainConversationId: "parent-ignore",
      bindings: {
        "parent-ignore": {
          conversationId: "parent-ignore",
          role: "ORCHESTRATOR",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
        },
        "child-ignore": {
          conversationId: "child-ignore",
          parentConversationId: "parent-ignore",
          role: "WORKER",
          profile: "flash-low-worker",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
          delegationKind: "WORK",
          taskIdentifier: "ignore-runtime-files",
          attempt: 0,
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2));

    const output = execFileSync(process.execPath, [stopScript], {
      input: JSON.stringify({
        workspacePaths: [root],
        conversationId: "child-ignore",
        parentConversationId: "parent-ignore",
        taskId: "ignore-runtime-files",
        fullyIdle: true,
      }),
      encoding: "utf8",
    });
    const decision = JSON.parse(output);
    assert.equal(decision.decision, "continue");
    assert.match(decision.reason, /CHILD_EVIDENCE_REQUIRED/);
    assert.match(decision.reason, /git check-ignore/);

    const state = JSON.parse(readFileSync(join(root, ".agents", "state", "active-state.json"), "utf8"));
    assert.deepEqual(state.childEvidenceContinuation.requirementIds, ["ignore-check"]);
    assert.notEqual(state.state, "HUMAN_GATE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence: WORK child with its factual local command may terminate normally", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-child-evidence-pass-"));
  try {
    mkdirSync(join(root, ".agents", "state"), { recursive: true });
    const command = "git check-ignore -v .agents/hooks.json GEMINI.md";
    const contract = {
      allowedPaths: [".gitignore"],
      forbiddenPaths: [".agents/**"],
      testsRequired: [],
      requiredEvidence: [{
        id: "ignore-check",
        class: "LOCAL_COMMAND",
        kind: "LOCAL_COMMAND",
        command,
      }],
    };
    writeFileSync(join(root, ".agents", "state", "active-state.json"), JSON.stringify({
      state: "DELEGATED",
      taskAction: "MECHANICAL_FIX",
      taskId: "ignore-runtime-files-pass",
      attempt: 0,
      mutationSeq: 1,
      scopeContract: contract,
      evidenceLedger: [{
        id: "ev-ignore-check",
        executionId: "exec-ignore-check",
        type: "GENERIC_COMMAND_RESULT",
        scope: "GLOBAL",
        command,
        exitCode: 0,
        passed: null,
        failed: null,
        mutationSeq: 1,
        actorRole: "WORKER",
        actorId: "child-ignore-pass",
        conversationId: "child-ignore-pass",
        confidence: "HIGH",
        evidenceSource: "EXECUTION_HOOK",
        delegationKind: "WORK",
        attempt: 0,
      }],
    }, null, 2));
    writeFileSync(join(root, ".agents", "state", "active-contract.json"), JSON.stringify(contract, null, 2));
    writeFileSync(join(root, ".agents", "state", "role-bindings.json"), JSON.stringify({
      mainConversationId: "parent-ignore-pass",
      bindings: {
        "parent-ignore-pass": {
          conversationId: "parent-ignore-pass",
          role: "ORCHESTRATOR",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
        },
        "child-ignore-pass": {
          conversationId: "child-ignore-pass",
          parentConversationId: "parent-ignore-pass",
          role: "WORKER",
          profile: "flash-low-worker",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
          delegationKind: "WORK",
          taskIdentifier: "ignore-runtime-files-pass",
          attempt: 0,
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2));

    const output = execFileSync(process.execPath, [stopScript], {
      input: JSON.stringify({
        workspacePaths: [root],
        conversationId: "child-ignore-pass",
        parentConversationId: "parent-ignore-pass",
        taskId: "ignore-runtime-files-pass",
        fullyIdle: true,
      }),
      encoding: "utf8",
    });
    const decision = JSON.parse(output);
    assert.equal(decision.decision, "stop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence: LOCAL_FACT FILE_EXISTS and GIT_IGNORED are factual runtime evidence", () => {
  const root = initGitRepo();
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "plan.md"), "plan\n", "utf8");

    const state = {
      taskId: "mechanical-plan",
      attempt: 0,
      mutationSeq: 1,
    };

    const fileRecord = collectLocalFactRequirement({
      repoRoot: root,
      activeState: state,
      requirement: {
        id: "plan-file",
        class: "FILE_EXISTS",
        kind: "LOCAL_FACT",
        path: "docs/plan.md",
      },
    });
    assert.equal(fileRecord.result, "PASS");
    assert.equal(fileRecord.provenance.source, "ORCHESTRA_LOCAL_FACT_COLLECTOR");

    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents", "hooks.json"), "{}\n", "utf8");
    writeFileSync(join(root, "GEMINI.md"), "local\n", "utf8");

    const ignoredRecord = collectLocalFactRequirement({
      repoRoot: root,
      activeState: state,
      requirement: {
        id: "runtime-files-ignored",
        class: "GIT_IGNORED",
        kind: "LOCAL_FACT",
        paths: [".agents/hooks.json", "GEMINI.md"],
      },
    });
    assert.equal(ignoredRecord.result, "PASS");
    assert.equal(ignoredRecord.provenance.source, "ORCHESTRA_LOCAL_FACT_COLLECTOR");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence: GitHub repository parser supports HTTPS and SSH origins", () => {
  assert.equal(parseGitHubRepository("https://github.com/jssantogit/mihon.git"), "jssantogit/mihon");
  assert.equal(parseGitHubRepository("git@github.com:jssantogit/mihon.git"), "jssantogit/mihon");
  assert.equal(parseGitHubRepository("https://gitlab.com/example/repo.git"), null);
});

test("evidence: CI_WAIT and remote validation retry are first-class state-machine concepts", () => {
  assert.ok(STATE_NAMES.includes("CI_WAIT"));
  assert.ok(RETRY_REASONS.includes("REMOTE_VALIDATION_FAILURE"));
  assert.equal(validateStateTransition("DELEGATED", "CI_WAIT").valid, true);
  assert.equal(validateStateTransition("EXECUTING", "CI_WAIT").valid, true);
  assert.equal(validateStateTransition("CI_WAIT", "CI_WAIT").valid, true);
  assert.equal(validateStateTransition("CI_WAIT", "EVIDENCE_READY").valid, true);
  assert.equal(validateStateTransition("CI_WAIT", "PLANNED").valid, true);
});

test("evidence: optional local Gradle commands remain factual validation when declared", () => {
  const unit = "./gradlew testDebugUnitTest --tests \"tachiyomi.domain.tsuzuki.catalog.model.CatalogModelTest\"";
  const build = "./gradlew assembleDebug";
  const lint = "./gradlew spotlessCheck";

  assert.equal(isValidationCommand(unit), true);
  assert.equal(isValidationCommand(build), true);
  assert.equal(isValidationCommand(lint), true);
  assert.equal(classifyExecutionEvidence(unit, 0).type, "TEST_RUN");
  assert.equal(classifyExecutionEvidence(build, 0).type, "BUILD");
  assert.equal(classifyExecutionEvidence(lint, 0).type, "LINT");
});

test("evidence: delegation may explicitly replace inherited local tests with CI-first evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-evidence-hook-"));
  try {
    mkdirSync(join(root, ".agents", "state"), { recursive: true });
    writeFileSync(join(root, ".agents", "state", "active-state.json"), JSON.stringify({
      activeRole: "ORCHESTRATOR",
      state: "PLANNED",
      taskAction: "IMPLEMENT",
      taskId: "tsuzuki-ci-first",
      scopeContract: {
        allowedPaths: ["domain/**"],
        forbiddenPaths: [".agents/**"],
        testsRequired: ["./gradlew testDebugUnitTest"],
      },
    }, null, 2));
    writeFileSync(join(root, ".agents", "state", "active-contract.json"), JSON.stringify({
      allowedPaths: ["domain/**"],
      forbiddenPaths: [".agents/**"],
      testsRequired: ["./gradlew testDebugUnitTest"],
    }, null, 2));
    writeFileSync(join(root, ".agents", "state", "role-bindings.json"), JSON.stringify({
      mainConversationId: "orch-ci-first",
      bindings: {
        "orch-ci-first": {
          conversationId: "orch-ci-first",
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2));

    const input = JSON.stringify({
      workspacePaths: [root],
      conversationId: "orch-ci-first",
      toolCall: {
        id: "invoke-ci-first",
        name: "invoke_subagent",
        args: {
          Subagents: [{
            TypeName: "flash-medium-worker",
            Role: "worker",
            Model: "gemini-3.8-flash-medium",
            ScopeContract: {
              allowedPaths: ["domain/**"],
              forbiddenPaths: [".agents/**"],
              testsRequired: [],
              requiredEvidence: [FAST_CI_REQUIREMENT],
            },
            Prompt: "Implement the bounded Tsuzuki block. GitHub Fast CI is authoritative.",
          }],
        },
      },
    });

    const output = execFileSync(process.execPath, [preToolScript], {
      input,
      encoding: "utf8",
    });
    const decision = JSON.parse(output);
    assert.equal(decision.decision, "allow");

    const contract = JSON.parse(
      readFileSync(join(root, ".agents", "state", "active-contract.json"), "utf8")
    );
    assert.deepEqual(contract.testsRequired, []);
    assert.equal(contract.requiredEvidence.length, 1);
    assert.equal(contract.requiredEvidence[0].class, "FAST_CI");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
