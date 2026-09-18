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
  classifyMechanicalFastPath,
  isMechanicalFastPathActive,
} from "../../runtimes/antigravity/.agents/skills/orchestra/mechanical-fast-path.mjs";
import {
  DECISION_TYPES,
  deriveAvailableActions,
  deriveDecisionState,
} from "../../runtimes/antigravity/.agents/dream/action-space.mjs";

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

const IGNORE_EVIDENCE = Object.freeze({
  id: "runtime-files-ignored",
  class: "GIT_IGNORED",
  kind: "LOCAL_FACT",
  paths: [".agents/hooks.json", "GEMINI.md"],
});

function mechanicalContract(overrides = {}) {
  return {
    allowedPaths: [".gitignore"],
    forbiddenPaths: [".agents/**"],
    testsRequired: [],
    requiredEvidence: [structuredClone(IGNORE_EVIDENCE)],
    ...overrides,
  };
}

function writeRoleBindings(root, {
  includeChild = false,
  taskId = "mechanical-ignore",
} = {}) {
  const bindings = {
    "parent-mechanical": {
      conversationId: "parent-mechanical",
      role: "ORCHESTRATOR",
      profile: "flash-orchestrator",
      confidence: "HIGH",
      source: "RUNTIME_IDENTITY",
    },
  };
  if (includeChild) {
    bindings["child-mechanical"] = {
      conversationId: "child-mechanical",
      parentConversationId: "parent-mechanical",
      role: "WORKER",
      profile: "flash-low-worker",
      confidence: "HIGH",
      source: "RUNTIME_IDENTITY",
      delegationKind: "WORK",
      taskIdentifier: taskId,
      attempt: 0,
    };
  }

  writeFileSync(
    join(root, ".agents", "state", "role-bindings.json"),
    JSON.stringify({
      mainConversationId: "parent-mechanical",
      bindings,
      conversations: {},
      pendingSubagents: [],
    }, null, 2)
  );
}

function setupHookState({
  state = "DELEGATED",
  contract = mechanicalContract(),
  marker = null,
  workerWorkspaceWrites = 0,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-mechanical-hook-"));
  mkdirSync(join(root, ".agents", "state"), { recursive: true });

  const fastPath = marker || {
    schema: "orchestra.mechanical-fast-path.v1",
    eligible: true,
    active: true,
    status: "ACTIVE",
    taskAction: "MECHANICAL_FIX",
    criticality: "NORMAL",
    targetWorker: "flash-low-worker",
    allowedPaths: [".gitignore"],
    forbiddenPaths: [".agents/**"],
    requirementIds: ["runtime-files-ignored"],
    requirementClasses: ["GIT_IGNORED"],
    testsRequiredCount: 0,
    maxMutationCalls: 2,
    workerWritesAtStart: 0,
  };

  writeFileSync(join(root, ".agents", "state", "active-state.json"), JSON.stringify({
    activeRole: "ORCHESTRATOR",
    conversationId: "parent-mechanical",
    state,
    taskAction: "MECHANICAL_FIX",
    taskDomain: "GENERAL",
    criticality: "NORMAL",
    taskId: "mechanical-ignore",
    attempt: 0,
    mutationSeq: 0,
    workerWorkspaceWrites,
    scopeContract: contract,
    mechanicalFastPath: fastPath,
  }, null, 2));
  writeFileSync(
    join(root, ".agents", "state", "active-contract.json"),
    JSON.stringify(contract, null, 2)
  );
  writeRoleBindings(root, { includeChild: true });
  return root;
}

function runPreTool(root, conversationId, toolCall) {
  const output = execFileSync(process.execPath, [preToolScript], {
    input: JSON.stringify({
      workspacePaths: [root],
      conversationId,
      toolCall,
    }),
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function initGitAcceptanceRepo({ ignoreGemini = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-mechanical-stop-"));
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Orchestra Tests"]);
  execFileSync("git", ["-C", root, "config", "user.email", "orchestra@example.invalid"]);

  const gitignore = ".agents/\n" + (ignoreGemini ? "GEMINI.md\n" : "");
  writeFileSync(join(root, ".gitignore"), gitignore);
  execFileSync("git", ["-C", root, "add", ".gitignore"]);
  execFileSync("git", ["-C", root, "commit", "-m", "fixture"]);

  mkdirSync(join(root, ".agents", "state"), { recursive: true });
  writeFileSync(join(root, ".agents", "hooks.json"), "{}\n");
  writeFileSync(join(root, "GEMINI.md"), "runtime\n");
  return root;
}

function writeAcceptanceState(root) {
  const contract = mechanicalContract();
  const activeState = {
    activeRole: "ORCHESTRATOR",
    conversationId: "parent-mechanical",
    state: "EXECUTING",
    taskAction: "MECHANICAL_FIX",
    taskDomain: "GENERAL",
    criticality: "NORMAL",
    taskId: "mechanical-ignore",
    attempt: 0,
    mutationSeq: 1,
    acceptanceState: "PENDING",
    workerWorkspaceWrites: 1,
    orchestratorWorkspaceWrites: 0,
    unknownWorkspaceWrites: 0,
    workerCompletionClaimed: true,
    workerCompletionClaimFactual: true,
    implementationComplete: true,
    workerCompletionClaimIdentity: {
      actorId: "child-mechanical",
      source: "RUNTIME_IDENTITY",
      confidence: "HIGH",
      delegationKind: "WORK",
      attempt: 0,
    },
    scopeContract: contract,
    evidenceLedger: [],
    mechanicalFastPath: {
      schema: "orchestra.mechanical-fast-path.v1",
      eligible: true,
      active: true,
      status: "ACTIVE",
      taskAction: "MECHANICAL_FIX",
      criticality: "NORMAL",
      targetWorker: "flash-low-worker",
      allowedPaths: [".gitignore"],
      forbiddenPaths: [".agents/**"],
      requirementIds: ["runtime-files-ignored"],
      requirementClasses: ["GIT_IGNORED"],
      testsRequiredCount: 0,
      maxMutationCalls: 2,
      workerWritesAtStart: 0,
    },
  };

  writeFileSync(
    join(root, ".agents", "state", "active-state.json"),
    JSON.stringify(activeState, null, 2)
  );
  writeFileSync(
    join(root, ".agents", "state", "active-contract.json"),
    JSON.stringify(contract, null, 2)
  );
  writeRoleBindings(root, { includeChild: true });
}

test("mechanical fast path: Dream worker-tier authority stays aligned with low-worker router", () => {
  const derived = deriveDecisionState({
    taskAction: "MECHANICAL_FIX",
    taskDomain: "GENERAL",
    criticality: "NORMAL",
  });
  assert.equal(derived.task_action, "MECHANICAL_FIX");
  assert.equal(derived.complexity, "MECHANICAL");

  assert.deepEqual(
    deriveAvailableActions(DECISION_TYPES.WORKER_TIER, {
      task_action: "MECHANICAL_FIX",
      task_domain: "GENERAL",
      criticality: "NORMAL",
      complexity: "NORMAL",
    }),
    ["FLASH_LOW"],
  );
});

test("mechanical fast path: .gitignore + runtime-owned GIT_IGNORED is eligible", () => {
  const result = classifyMechanicalFastPath({
    taskAction: "MECHANICAL_FIX",
    criticality: "NORMAL",
    scopeContract: mechanicalContract(),
    requestedProfile: "flash-low-worker",
    attempt: 0,
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.allowedPaths, [".gitignore"]);
  assert.deepEqual(result.requirementClasses, ["GIT_IGNORED"]);
  assert.equal(result.targetWorker, "flash-low-worker");
});

test("mechanical fast path: falls back for risk, broad scope, tests, remote evidence, or weak facts", () => {
  const cases = [
    {
      name: "major",
      input: { criticality: "MAJOR", scopeContract: mechanicalContract() },
      reason: "CRITICALITY_NOT_NORMAL",
    },
    {
      name: "sensitive target",
      input: { criticality: "NORMAL", scopeContract: mechanicalContract({ allowedPaths: [".github/workflows/ci.yml"] }) },
      reason: "SENSITIVE_PATH",
    },
    {
      name: "broad scope",
      input: { criticality: "NORMAL", scopeContract: mechanicalContract({ allowedPaths: ["docs/**"] }) },
      reason: "SCOPE_NOT_CONCRETE",
    },
    {
      name: "local test",
      input: { criticality: "NORMAL", scopeContract: mechanicalContract({ testsRequired: ["npm test"] }) },
      reason: "LOCAL_COMMAND_VALIDATION_REQUIRED",
    },
    {
      name: "remote CI",
      input: {
        criticality: "NORMAL",
        scopeContract: mechanicalContract({
          requiredEvidence: [{
            id: "ci",
            class: "FAST_CI",
            kind: "REMOTE_CI",
            provider: "GITHUB_ACTIONS",
            workflow: { path: ".github/workflows/ci.yml" },
            requiredJobs: ["test"],
          }],
        }),
      },
      reason: "NON_LOCAL_FACT_EVIDENCE",
    },
    {
      name: "metadata-only fact",
      input: {
        criticality: "NORMAL",
        scopeContract: mechanicalContract({
          requiredEvidence: [{ id: "head", class: "HEAD_SHA", kind: "LOCAL_FACT" }],
        }),
      },
      reason: "OUTCOME_FACT_REQUIRED",
    },
  ];

  for (const fixture of cases) {
    const result = classifyMechanicalFastPath({
      taskAction: "MECHANICAL_FIX",
      requestedProfile: "flash-low-worker",
      attempt: 0,
      ...fixture.input,
    });
    assert.equal(result.eligible, false, fixture.name);
    assert.ok(result.reasons.includes(fixture.reason), fixture.name + " missing " + fixture.reason);
  }
});

test("mechanical fast path: invoke_subagent activates marker for one flash-low worker", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-mechanical-activate-"));
  try {
    mkdirSync(join(root, ".agents", "state"), { recursive: true });
    writeFileSync(join(root, ".agents", "state", "active-state.json"), JSON.stringify({
      activeRole: "ORCHESTRATOR",
      state: "PLANNED",
      taskAction: "MECHANICAL_FIX",
      taskDomain: "GENERAL",
      criticality: "NORMAL",
      taskId: "mechanical-ignore",
      attempt: 0,
      mutationSeq: 0,
      scopeContract: mechanicalContract(),
    }, null, 2));
    writeFileSync(
      join(root, ".agents", "state", "active-contract.json"),
      JSON.stringify(mechanicalContract(), null, 2)
    );
    writeRoleBindings(root);

    const decision = runPreTool(root, "parent-mechanical", {
      id: "invoke-mechanical",
      name: "invoke_subagent",
      args: {
        Subagents: [{
          TypeName: "flash-low-worker",
          Role: "worker",
          Model: "gemini-3.8-flash-low",
          ScopeContract: mechanicalContract(),
          Prompt: "Edit only .gitignore. Runtime LOCAL_FACT evidence is authoritative.",
        }],
      },
    });

    assert.equal(decision.decision, "allow");
    const state = JSON.parse(
      readFileSync(join(root, ".agents", "state", "active-state.json"), "utf8")
    );
    assert.equal(state.state, "DELEGATED");
    assert.equal(isMechanicalFastPathActive(state), true);
    assert.equal(state.mechanicalFastPath.targetWorker, "flash-low-worker");
    assert.deepEqual(state.mechanicalFastPath.requirementClasses, ["GIT_IGNORED"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mechanical fast path: concrete worker cannot search, inspect outside scope, or run shell ceremony", () => {
  const root = setupHookState();
  try {
    const search = runPreTool(root, "child-mechanical", {
      id: "search-side-quest",
      name: "grep_search",
      args: { Query: "gitignore" },
    });
    assert.equal(search.decision, "deny");
    assert.match(search.reason, /MECHANICAL_FAST_PATH_SEARCH_PROHIBITED/);

    const allowedRead = runPreTool(root, "child-mechanical", {
      id: "read-target",
      name: "view_file",
      args: { FilePath: ".gitignore" },
    });
    assert.equal(allowedRead.decision, "allow");

    const outsideRead = runPreTool(root, "child-mechanical", {
      id: "read-outside",
      name: "view_file",
      args: { FilePath: "README.md" },
    });
    assert.equal(outsideRead.decision, "deny");
    assert.match(outsideRead.reason, /MECHANICAL_FAST_PATH_READ_SCOPE/);

    const shell = runPreTool(root, "child-mechanical", {
      id: "git-status-side-quest",
      name: "run_command",
      args: { CommandLine: "git status --short" },
    });
    assert.equal(shell.decision, "deny");
    assert.match(shell.reason, /MECHANICAL_FAST_PATH_SHELL_PROHIBITED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mechanical fast path: bounded native mutation is allowed but budget is enforced", () => {
  const root = setupHookState();
  try {
    const mutation = runPreTool(root, "child-mechanical", {
      id: "edit-gitignore",
      name: "write_to_file",
      args: { FilePath: ".gitignore", Content: ".agents/\nGEMINI.md\n" },
    });
    assert.equal(mutation.decision, "allow");

    const statePath = join(root, ".agents", "state", "active-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.workerWorkspaceWrites = state.mechanicalFastPath.workerWritesAtStart
      + state.mechanicalFastPath.maxMutationCalls;
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const overBudget = runPreTool(root, "child-mechanical", {
      id: "edit-over-budget",
      name: "write_to_file",
      args: { FilePath: ".gitignore", Content: ".agents/\nGEMINI.md\n*.tmp\n" },
    });
    assert.equal(overBudget.decision, "deny");
    assert.match(overBudget.reason, /MECHANICAL_FAST_PATH_MUTATION_BUDGET/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mechanical fast path: parent cannot add a second subagent while bounded worker is active", () => {
  const root = setupHookState();
  try {
    const decision = runPreTool(root, "parent-mechanical", {
      id: "second-worker",
      name: "invoke_subagent",
      args: {
        Subagents: [{
          TypeName: "flash-low-worker",
          Role: "worker",
          Model: "gemini-3.8-flash-low",
          ScopeContract: mechanicalContract(),
          Prompt: "Do more work.",
        }],
      },
    });
    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /MECHANICAL_FAST_PATH_SIDE_QUEST/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mechanical fast path: runtime GIT_IGNORED evidence reaches normal parent acceptance and DONE", () => {
  const root = initGitAcceptanceRepo({ ignoreGemini: true });
  try {
    writeAcceptanceState(root);

    const output = execFileSync(process.execPath, [stopScript], {
      input: JSON.stringify({
        workspacePaths: [root],
        conversationId: "parent-mechanical",
        taskId: "mechanical-ignore",
        fullyIdle: true,
      }),
      encoding: "utf8",
    });
    const decision = JSON.parse(output);
    assert.equal(decision.decision, "stop");

    const state = JSON.parse(
      readFileSync(join(root, ".agents", "state", "active-state.json"), "utf8")
    );
    assert.equal(state.acceptanceState, "ACCEPTED");
    assert.equal(state.state, "DONE");
    assert.equal(state.evidenceContractStatus, "SATISFIED");
    assert.equal(state.mechanicalFastPath.active, false);
    assert.equal(state.mechanicalFastPath.status, "DONE");

    const record = (state.evidenceLedger || []).find((item) => item.requirementId === "runtime-files-ignored");
    assert.ok(record);
    assert.equal(record.result, "PASS");
    assert.equal(record.provenance.source, "ORCHESTRA_LOCAL_FACT_COLLECTOR");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mechanical fast path: failed runtime fact never accepts and exits short mode for recovery", () => {
  const root = initGitAcceptanceRepo({ ignoreGemini: false });
  try {
    writeAcceptanceState(root);

    const output = execFileSync(process.execPath, [stopScript], {
      input: JSON.stringify({
        workspacePaths: [root],
        conversationId: "parent-mechanical",
        taskId: "mechanical-ignore",
        fullyIdle: true,
      }),
      encoding: "utf8",
    });
    const decision = JSON.parse(output);
    assert.equal(decision.decision, "continue");

    const state = JSON.parse(
      readFileSync(join(root, ".agents", "state", "active-state.json"), "utf8")
    );
    assert.notEqual(state.acceptanceState, "ACCEPTED");
    assert.notEqual(state.state, "DONE");
    assert.equal(state.mechanicalFastPath.active, false);
    assert.match(state.mechanicalFastPath.status, /^FAILED_EVIDENCE_/);
    assert.equal(state.retryReason, "INCOMPLETE_IMPLEMENTATION");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
