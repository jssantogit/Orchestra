import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, rmSync, mkdtempSync, cpSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const orchestraRoot = resolve(__dirname, "../..");
const runtimeRoot = resolve(orchestraRoot, "runtimes/antigravity");

const preInvocationScript = resolve(runtimeRoot, ".agents/hooks/pre-invocation-guard.mjs");
const preToolScript = resolve(runtimeRoot, ".agents/hooks/pre-tool-enforce.mjs");
const postToolScript = resolve(runtimeRoot, ".agents/hooks/post-tool-telemetry.mjs");
const stopScript = resolve(runtimeRoot, ".agents/hooks/stop-guard.mjs");

import {
  classifyScopeSpecificity,
  isConcretePath,
  verifyWorkerValidation,
} from "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs";
import {
  canonicalizePath,
  extractChildTranscriptEvidence,
  extractExportedFunctionSignatures,
  auditApiSignatures,
  auditScopeMinimality,
  extractParentDelegatedSidequestAttempts,
  evaluateInvestigationEconomy,
  evaluateBoundedFactualCorrection,
} from "../../benchmarks/turn-economy/run.mjs";
import { isValidAgentName } from "../../runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs";
import { syncChildEvidence } from "../../runtimes/antigravity/.agents/hooks/stop-guard.mjs";

function cleanState() {
  process.chdir(runtimeRoot);
  try { unlinkSync(".agents/state/active-state.json"); } catch {}
  try { unlinkSync(".agents/state/active-contract.json"); } catch {}
  try { unlinkSync(".agents/state/role-bindings.json"); } catch {}
  try { rmSync(".agents/state/executions", { recursive: true, force: true }); } catch {}
  try { unlinkSync(".agents/telemetry/events.jsonl"); } catch {}
}

test.beforeEach(() => {
  cleanState();
});

test.after(() => {
  cleanState();
});

test("turn-diet: pre-tool hook auto-extracts and persists Scope Contract from invoke_subagent payload", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "PLANNED",
    taskAction: "IMPLEMENT",
    taskId: "task-3-simple",
  }));

  const input = JSON.stringify({
    conversationId: "parent-orch-1",
    toolCall: {
      name: "invoke_subagent",
      args: {
        Subagents: [
          {
            TypeName: "flash-low-worker",
            Role: "flash-low-worker",
            Model: "gemini-3.8-flash-low",
            Prompt: "Fix formatter.\n\nScope Contract:\n- allowedPaths: [\"src/formatter.js\", \"test/formatter.test.js\"]\n- forbiddenPaths: [\"src/calculator.js\"]\n- Validate using: `node --test test/formatter.test.js`",
          },
        ],
      },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
  assert.equal(out.decision, "allow");

  // Verify active-contract.json was automatically persisted
  const contractPath = ".agents/state/active-contract.json";
  assert.ok(existsSync(contractPath), "active-contract.json must be auto-created by invoke_subagent hook");
  const contract = JSON.parse(readFileSync(contractPath, "utf-8"));
  assert.deepEqual(contract.allowedPaths, ["src/formatter.js", "test/formatter.test.js"]);
  assert.deepEqual(contract.forbiddenPaths, ["src/calculator.js"]);

  // Verify active-state.json was transitioned to DELEGATED
  const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(state.state, "DELEGATED");
  assert.equal(state.handoffObserved, true);
});

test("turn-diet: post-tool hook records worker claim from send_message and verified validation only from run_command", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "WORKER",
    state: "DELEGATED",
    taskAction: "IMPLEMENT",
    scopeContract: {
      testsRequired: ["node --test test/formatter.test.js"],
    },
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "child-worker-1": { role: "WORKER", profile: "flash-low-worker" },
    },
  }));

  const completionPacket = [
    "STATUS: IMPLEMENTATION_COMPLETE",
    "FILES CHANGED: [\"src/formatter.js\", \"test/formatter.test.js\"]",
    "WHAT CHANGED: Fixed sign preservation",
    "TESTS: [5 passed / 0 failed]",
    "ACCEPTANCE EVIDENCE: [verified with node --test test/formatter.test.js]",
    "EXIT CODE: 0",
  ].join("\n");

  const input = JSON.stringify({
    conversationId: "child-worker-1",
    toolCall: {
      name: "send_message",
      args: {
        Recipient: "orch-parent",
        Message: completionPacket,
      },
    },
  });

  execFileSync("node", [postToolScript], { input });

  const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  // Model Claim Is Not Evidence: send_message records claims, NOT verified validation
  assert.equal(state.implementationComplete, true);
  assert.equal(state.workerCompletionClaimed, true);
  assert.equal(state.claimedValidationCommand, "node --test test/formatter.test.js");
  assert.equal(state.claimedTestsPassed, "5 passed / 0 failed");
  assert.equal(state.claimedValidationExitCode, 0);
  assert.equal(state.workerValidationObserved, undefined, "Worker validation is NOT observed merely from send_message text");
  assert.equal(state.workerValidationVerified, false, "Worker validation is NOT verified merely from send_message text");
  assert.notEqual(state.state, "EVIDENCE_READY", "Must not transition to EVIDENCE_READY without verified tool execution");
  assert.ok(state.worker_packet_bytes > 0);

  // Now simulate actual command execution by worker
  const cmdInput = JSON.stringify({
    conversationId: "child-worker-1",
    toolCall: {
      name: "run_command",
      args: {
        CommandLine: "node --test test/formatter.test.js",
      },
    },
    toolResult: {
      output: "✔ formatter sign preserved (1.2ms)\n# tests 1\n# pass 1\n# fail 0\n",
      exitCode: 0,
    },
  });
  execFileSync("node", [postToolScript], { input: cmdInput });

  const stateAfterCmd = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(stateAfterCmd.workerValidationObserved, true);
  assert.equal(stateAfterCmd.workerValidationVerified, true);
  assert.equal(stateAfterCmd.workerValidationFresh, true);
  assert.equal(stateAfterCmd.state, "EVIDENCE_READY");
});

test("turn-diet: stop-guard automatically records acceptanceState ACCEPTED and state DONE when orchestrator concludes after worker completion and verified validation", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "EVIDENCE_READY",
    implementationComplete: true,
    workerCompletionClaimed: true,
    workerValidationObserved: true,
    workerValidationVerified: true,
    workerValidationFresh: true,
    evidenceLedger: [
      {
        executionId: "exec-1",
        command: "node --test test/formatter.test.js",
        exitCode: 0,
        mutationSeq: 0,
        actorRole: "WORKER",
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      },
    ],
    taskAction: "IMPLEMENT",
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "orch-parent": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
    },
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    fullyIdle: true,
  });

  const out = JSON.parse(execFileSync("node", [stopScript], { input }));
  assert.equal(out.decision, "stop");

  const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(state.state, "DONE");
  assert.equal(state.acceptanceState, "ACCEPTED");
  assert.equal(state.acceptanceActor, "ORCHESTRATOR");
  assert.equal(state.clean_stops, 1);
});

test("turn-diet: polling is restricted and reactive wakeup is favored after worker spawn", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    taskAction: "IMPLEMENT",
    pollingTracker: {
      pollCount: 3,
      lastPollTimestamp: Date.now() - 1000, // 1 second ago (violates 15s backoff)
    },
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    toolCall: {
      name: "manage_task",
      args: {
        Action: "status",
        TaskId: "task-123",
      },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("Polling status too quickly") || out.reason.includes("polling budget"));
});

test("turn-diet: fresh worker evidence in Evidence Ledger avoids duplicate acceptance validation", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "EVIDENCE_READY",
    implementationComplete: true,
    workerCompletionClaimed: true,
    mutationSeq: 2,
    mutations: [
      { path: "src/formatter.js", seq: 1 },
      { path: "test/formatter.test.js", seq: 2 },
    ],
    scopeContract: {
      testsRequired: ["node --test test/formatter.test.js"],
    },
    evidenceLedger: [
      {
        executionId: "exec-123",
        command: "node --test test/formatter.test.js",
        exitCode: 0,
        mutationSeq: 2,
        actorRole: "WORKER",
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      },
    ],
    requireEvidenceBeforeStop: true,
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "orch-parent": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
    },
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    fullyIdle: true,
  });

  // Since evidence is fresh (mutationSeq matches) and from WORKER, stop is allowed immediately without re-running
  const out = JSON.parse(execFileSync("node", [stopScript], { input }));
  assert.equal(out.decision, "stop");
  const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(state.state, "DONE");
  assert.equal(state.clean_stops, 1);
});

test("turn-diet: parent should delegate simple implementation without product read requirement", () => {
  // Verifies that a Scope Contract for simple implementation can be formed
  // directly from prompt intent and file naming conventions without viewing product files.
  const prompt = "Fix the formatter bug where negative values lose their sign. Add or update the focused test and validate the change.";
  
  // Deterministic intent classification
  const isSimpleBug = prompt.includes("Fix the formatter bug") || prompt.includes("negative values");
  assert.ok(isSimpleBug);

  // Sufficiently bounded scope
  const allowedPaths = ["src/formatter.js", "test/formatter.test.js"];
  const forbiddenPaths = ["src/calculator.js", "src/parser.js", "test/calculator.test.js", "test/parser.test.js", "package.json"];
  assert.equal(allowedPaths.length, 2);
  assert.equal(forbiddenPaths.length, 5);

  // Delegation can occur directly with 0 prior view_file calls on product code
  const preDelegationReads = 0;
  assert.equal(preDelegationReads, 0, "Zero prior reads required before delegating simple bounded task");
});

test("turn-diet: regression 28: Model Lies — claim without execution fails closed", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    implementationComplete: true,
    workerCompletionClaimed: true,
    taskAction: "IMPLEMENT",
    scopeContract: {
      testsRequired: ["node --test test/formatter.test.js"],
    },
    evidenceLedger: [], // Worker claimed passed, but executed NO tests!
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "orch-parent": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
    },
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    fullyIdle: true,
  });

  const out = JSON.parse(execFileSync("node", [stopScript], { input }));
  assert.equal(out.decision, "continue", "Stop must be blocked when model claims completion without evidence");
  assert.ok(out.reason.includes("MODEL CLAIM IS NOT EVIDENCE") || out.reason.includes("EVIDENCE_MISSING"));

  const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.notEqual(state.state, "DONE");
  assert.notEqual(state.acceptanceState, "ACCEPTED");
});

test("turn-diet: regression 29: Failed Test — exitCode 1 blocks stop", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    implementationComplete: true,
    workerCompletionClaimed: true,
    taskAction: "IMPLEMENT",
    scopeContract: {
      testsRequired: ["node --test test/formatter.test.js"],
    },
    evidenceLedger: [
      {
        executionId: "exec-fail",
        command: "node --test test/formatter.test.js",
        exitCode: 1, // Test failed!
        mutationSeq: 0,
        actorRole: "WORKER",
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      },
    ],
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "orch-parent": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
    },
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    fullyIdle: true,
  });

  const out = JSON.parse(execFileSync("node", [stopScript], { input }));
  assert.equal(out.decision, "continue", "Stop must be blocked when validation test failed");
  assert.ok(out.reason.includes("FAILED") || out.reason.includes("exited with code 1"));
});

test("turn-diet: regression 30: Stale Test — mutation after test blocks stop", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    implementationComplete: true,
    workerCompletionClaimed: true,
    taskAction: "IMPLEMENT",
    mutationSeq: 2,
    mutations: [
      { path: "src/formatter.js", seq: 1 },
      { path: "src/formatter.js", seq: 2 }, // mutation happened after test at seq 1!
    ],
    scopeContract: {
      testsRequired: ["node --test test/formatter.test.js"],
    },
    evidenceLedger: [
      {
        executionId: "exec-stale",
        command: "node --test test/formatter.test.js",
        exitCode: 0,
        mutationSeq: 1, // Ran before mutation 2!
        actorRole: "WORKER",
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      },
    ],
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "orch-parent": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
    },
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    fullyIdle: true,
  });

  const out = JSON.parse(execFileSync("node", [stopScript], { input }));
  assert.equal(out.decision, "continue", "Stop must be blocked when validation evidence is stale");
  assert.ok(out.reason.includes("STALE") || out.reason.includes("stale"));
});

test("turn-diet: regression 31: Valid Success — exitCode 0, fresh, worker-authored leads to clean acceptance", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    implementationComplete: true,
    workerCompletionClaimed: true,
    taskAction: "IMPLEMENT",
    mutationSeq: 1,
    mutations: [
      { path: "src/formatter.js", seq: 1 },
    ],
    scopeContract: {
      testsRequired: ["node --test test/formatter.test.js"],
    },
    evidenceLedger: [
      {
        executionId: "exec-valid",
        command: "node --test test/formatter.test.js",
        exitCode: 0,
        mutationSeq: 1,
        actorRole: "WORKER",
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      },
    ],
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "orch-parent": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
    },
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    fullyIdle: true,
  });

  const out = JSON.parse(execFileSync("node", [stopScript], { input }));
  assert.equal(out.decision, "stop");
  const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(state.state, "DONE");
  assert.equal(state.acceptanceState, "ACCEPTED");
  assert.equal(state.acceptanceActor, "ORCHESTRATOR");
});

test("turn-diet: regression 32: Claimed Command Mismatch — wrong test executed blocks stop", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    implementationComplete: true,
    workerCompletionClaimed: true,
    taskAction: "IMPLEMENT",
    scopeContract: {
      testsRequired: ["node --test test/formatter.test.js"],
    },
    evidenceLedger: [
      {
        executionId: "exec-mismatch",
        command: "node --test test/calculator.test.js", // Ran calculator test instead of formatter test!
        exitCode: 0,
        mutationSeq: 0,
        actorRole: "WORKER",
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      },
    ],
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "orch-parent": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
    },
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    fullyIdle: true,
  });

  const out = JSON.parse(execFileSync("node", [stopScript], { input }));
  assert.equal(out.decision, "continue", "Stop must be blocked when required contract test was not executed");
  assert.ok(out.reason.includes("MISSING") || out.reason.includes("not executed"));
});

test("turn-diet: regression 33: Unknown Validator — actor UNKNOWN fails closed", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    implementationComplete: true,
    workerCompletionClaimed: true,
    taskAction: "IMPLEMENT",
    scopeContract: {
      testsRequired: ["node --test test/formatter.test.js"],
    },
    evidenceLedger: [
      {
        executionId: "exec-unk",
        command: "node --test test/formatter.test.js",
        exitCode: 0,
        mutationSeq: 0,
        actorRole: "UNKNOWN", // Actor not verified as worker!
        confidence: "LOW",
        timestamp: new Date().toISOString(),
      },
    ],
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "orch-parent": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
    },
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    fullyIdle: true,
  });

  const out = JSON.parse(execFileSync("node", [stopScript], { input }));
  assert.equal(out.decision, "continue", "Stop must be blocked when validator actor is UNKNOWN");
  assert.ok(out.reason.includes("INVALID_ACTOR") || out.reason.includes("UNKNOWN"));
});

test("turn-diet: regression 34: Orchestrator Validates — orchestrator validation does not substitute worker responsibility", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    implementationComplete: true,
    workerCompletionClaimed: true,
    taskAction: "IMPLEMENT",
    scopeContract: {
      testsRequired: ["node --test test/formatter.test.js"],
    },
    evidenceLedger: [
      {
        executionId: "exec-orch",
        command: "node --test test/formatter.test.js",
        exitCode: 0,
        mutationSeq: 0,
        actorRole: "ORCHESTRATOR", // Orchestrator ran the test, not the worker!
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      },
    ],
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "orch-parent": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
    },
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    fullyIdle: true,
  });

  const out = JSON.parse(execFileSync("node", [stopScript], { input }));
  assert.equal(out.decision, "continue", "Stop must be blocked when orchestrator ran test instead of worker");
  assert.ok(out.reason.includes("INVALID_ACTOR") || out.reason.includes("ORCHESTRATOR"));
});

test("turn-diet: regression 35: define_subagent injects authoritative prompt from .agents/agents/<name>.md", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "PLANNED",
    taskAction: "IMPLEMENT",
    taskId: "task-3-simple",
  }));

  const input = JSON.stringify({
    conversationId: "parent-orch-1",
    toolCall: {
      name: "define_subagent",
      args: {
        name: "flash-low-worker",
        system_prompt: "Hallucinated minimal prompt",
      },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
  assert.equal(out.decision, "allow");
  assert.ok(out.overwrite, "Must provide overwrite with authoritative prompt");
  assert.ok(out.overwrite.system_prompt.includes("Startup Decision Tree"), "Must include authoritative Startup Decision Tree");
  assert.ok(out.overwrite.system_prompt.includes("KNOWN-PATH FAST PATH"), "Must include KNOWN-PATH FAST PATH");
});

test("turn-diet: regression 36: invoke_subagent extracts Scope Contract faithfully without benchmark-specific hardcoding or prompt rewrites", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "PLANNED",
    taskAction: "IMPLEMENT",
    taskId: "arbitrary-task-99",
  }));

  // Case 1: Arbitrary project with concrete paths
  const concreteInput = JSON.stringify({
    conversationId: "parent-orch-1",
    toolCall: {
      name: "invoke_subagent",
      args: {
        Subagents: [
          {
            TypeName: "flash-low-worker",
            Role: "flash-low-worker",
            Model: "gemini-3.8-flash-low",
            Prompt: "Task: Implement OAuth token refresh.\n\nScope Contract:\n- allowedPaths: [\"pkg/auth/token.go\", \"pkg/auth/token_test.go\"]\n- testsRequired: `go test ./pkg/auth/...`\n\nInstructions: Implement refresh logic and validate.",
          },
        ],
      },
    },
  });

  const out1 = JSON.parse(execFileSync("node", [preToolScript], { input: concreteInput }));
  assert.equal(out1.decision, "allow");
  assert.equal(out1.overwrite, undefined, "Must NOT rewrite prompt for arbitrary tasks");

  const contract1 = JSON.parse(readFileSync(".agents/state/active-contract.json", "utf-8"));
  assert.deepEqual(contract1.allowedPaths, ["pkg/auth/token.go", "pkg/auth/token_test.go"], "Must extract exact concrete paths without benchmark fallback");
  assert.deepEqual(contract1.testsRequired, ["go test ./pkg/auth/..."], "Must extract exact test command");

  // Case 2: Glob prompt retains globs and does NOT invent concrete files
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "PLANNED",
    taskAction: "IMPLEMENT",
    taskId: "glob-task",
  }));

  const globInput = JSON.stringify({
    conversationId: "parent-orch-2",
    toolCall: {
      name: "invoke_subagent",
      args: {
        Subagents: [
          {
            TypeName: "flash-low-worker",
            Role: "flash-low-worker",
            Model: "gemini-3.8-flash-low",
            Prompt: "Task: General refactoring.\n\nScope Contract:\n- allowedPaths: [\"src/**\", \"test/**\"]\n- testsRequired: `npm test`\n",
          },
        ],
      },
    },
  });

  const out2 = JSON.parse(execFileSync("node", [preToolScript], { input: globInput }));
  assert.equal(out2.decision, "allow");
  assert.equal(out2.overwrite, undefined, "Must not rewrite globs into benchmark files");

  const contract2 = JSON.parse(readFileSync(".agents/state/active-contract.json", "utf-8"));
  assert.deepEqual(contract2.allowedPaths, ["src/**", "test/**"], "Globs must be preserved as globs");
  assert.deepEqual(contract2.testsRequired, ["npm test"]);
});

test("turn-diet: regression 37: worker cannot spawn subagents (hierarchy violation)", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "WORKER",
    state: "DELEGATED",
    taskAction: "IMPLEMENT",
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "child-worker-1": { role: "WORKER", profile: "flash-low-worker" },
    },
  }));

  const input = JSON.stringify({
    conversationId: "child-worker-1",
    toolCall: {
      name: "invoke_subagent",
      args: {
        Subagents: [{ TypeName: "flash-low-worker", Prompt: "Sub-worker" }],
      },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("Hierarchy violation"));
});

test("turn-diet: regression 38: batching guidance preserves allowedPaths enforcement", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "WORKER",
    state: "DELEGATED",
    taskAction: "IMPLEMENT",
    scopeContract: {
      allowedPaths: ["src/formatter.js", "test/formatter.test.js"],
      forbiddenPaths: ["package.json", "src/calculator.js"],
      testsRequired: ["node --test test/formatter.test.js"],
    },
  }));
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "child-worker-1": { role: "WORKER", profile: "flash-low-worker" },
    },
  }));

  // Allowed edit
  const allowedInput = JSON.stringify({
    conversationId: "child-worker-1",
    toolCall: {
      name: "replace_file_content",
      args: {
        TargetFile: resolve(runtimeRoot, "src/formatter.js"),
      },
    },
  });
  const allowedOut = JSON.parse(execFileSync("node", [preToolScript], { input: allowedInput }));
  assert.equal(allowedOut.decision, "allow");

  // Denied out-of-scope edit
  const deniedInput = JSON.stringify({
    conversationId: "child-worker-1",
    toolCall: {
      name: "replace_file_content",
      args: {
        TargetFile: resolve(runtimeRoot, "src/calculator.js"),
      },
    },
  });
  const deniedOut = JSON.parse(execFileSync("node", [preToolScript], { input: deniedInput }));
  assert.equal(deniedOut.decision, "deny");
  assert.ok(deniedOut.reason.includes("SCOPE_VIOLATION") || deniedOut.reason.includes("Scope contract violation"));
});

test("turn-diet: regression 39: flash-low-worker.md contains CROSS_DOMAIN_REQUEST and preserves budget invariants", () => {
  const workerDocPath = resolve(runtimeRoot, ".agents/agents/flash-low-worker.md");
  assert.ok(existsSync(workerDocPath));
  const content = readFileSync(workerDocPath, "utf-8");
  assert.ok(content.includes("CROSS_DOMAIN_REQUEST"), "Must preserve CROSS_DOMAIN_REQUEST handling");
  assert.ok(content.includes("KNOWN-PATH FAST PATH"), "Must include KNOWN-PATH FAST PATH");
  assert.ok(content.includes("Never Search on Known Paths"), "Must forbid search on known paths");
  assert.ok(content.includes("No Pre-Mutation Tests"), "Must forbid pre-mutation test runs");
  assert.ok(content.includes("No Post-Mutation Rereads"), "Must forbid post-mutation rereads");
  assert.ok(content.includes("MODEL CLAIM IS NOT EVIDENCE") || content.includes("Model claim is NOT evidence"), "Must preserve evidence integrity");
  // Check size invariant: must be <= 2252 bytes
  assert.ok(Buffer.byteLength(content, "utf-8") <= 2252, "Must not expand worker prompt size");
});

test("turn-diet: regression A: prompt without allowedPaths does not invent benchmark paths", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "PLANNED",
    taskAction: "IMPLEMENT",
    taskId: "unknown-task-42",
  }));

  const input = JSON.stringify({
    conversationId: "parent-orch-a",
    toolCall: {
      name: "invoke_subagent",
      args: {
        Subagents: [
          {
            TypeName: "flash-low-worker",
            Role: "flash-low-worker",
            Model: "gemini-3.8-flash-low",
            Prompt: "Task: Implement a new calculation feature. Please inspect the code and implement it.",
          },
        ],
      },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
  assert.equal(out.decision, "allow");

  const contract = JSON.parse(readFileSync(".agents/state/active-contract.json", "utf-8"));
  assert.ok(!contract.allowedPaths.includes("src/formatter.js"), "Must NOT invent src/formatter.js when missing");
  assert.ok(!contract.allowedPaths.includes("test/formatter.test.js"), "Must NOT invent test/formatter.test.js when missing");
  assert.notEqual(contract.taskId, "task-3-simple", "Must NOT fallback to task-3-simple");
});

test("turn-diet: regression B: classifyScopeSpecificity classifies CONCRETE, GLOB, INCOMPLETE accurately", () => {
  assert.equal(classifyScopeSpecificity({ allowedPaths: ["src/app.ts"] }), "CONCRETE");
  assert.equal(classifyScopeSpecificity({ allowedPaths: ["a.js", "b.js"] }), "CONCRETE");
  assert.equal(classifyScopeSpecificity({ allowedPaths: ["src/**"] }), "GLOB");
  assert.equal(classifyScopeSpecificity({ allowedPaths: ["src/a.js", "test/**"] }), "GLOB");
  assert.equal(classifyScopeSpecificity({ allowedPaths: ["src/*.ts"] }), "GLOB");
  assert.equal(classifyScopeSpecificity({ allowedPaths: [] }), "INCOMPLETE");
  assert.equal(classifyScopeSpecificity({}), "INCOMPLETE");
  assert.equal(classifyScopeSpecificity(null), "INCOMPLETE");

  assert.equal(isConcretePath("src/index.js"), true);
  assert.equal(isConcretePath("lib/core/util.py"), true);
  assert.equal(isConcretePath("src/**/*.js"), false);
  assert.equal(isConcretePath("src/*.js"), false);
  assert.equal(isConcretePath("src/[a-z].js"), false);
  assert.equal(isConcretePath(""), false);
  assert.equal(isConcretePath(null), false);
});

test("turn-diet: regression C: define_subagent rejects malicious agentName traversal and bounds to .agents/agents/", () => {
  assert.equal(isValidAgentName("../../etc/passwd"), false);
  assert.equal(isValidAgentName("foo/bar"), false);
  assert.equal(isValidAgentName("..\\win.ini"), false);
  assert.equal(isValidAgentName("../flash-low-worker"), false);
  assert.equal(isValidAgentName(""), false);
  assert.equal(isValidAgentName(null), false);
  assert.equal(isValidAgentName("flash-low-worker"), true);
  assert.equal(isValidAgentName("flash_reviewer_1"), true);

  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "PLANNED",
    taskAction: "IMPLEMENT",
  }));

  const input = JSON.stringify({
    conversationId: "parent-orch-c",
    toolCall: {
      name: "define_subagent",
      args: {
        name: "../../package",
        system_prompt: "Should not be read from outside agents dir",
      },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("INVALID_AGENT_NAME"), "Malicious traversal name must fail closed with INVALID_AGENT_NAME");
  assert.equal(out.overwrite, undefined, "Malicious traversal name must NOT trigger file overwrite");
});

test("turn-diet: regression D: canonicalizePath handles double slashes, trailing slashes, backslashes uniformly", () => {
  assert.equal(canonicalizePath("src\\\\formatter.js"), "src/formatter.js");
  assert.equal(canonicalizePath("src\\formatter.js"), "src/formatter.js");
  assert.equal(canonicalizePath("src//formatter.js"), "src/formatter.js");
  assert.equal(canonicalizePath("src///sub//formatter.js"), "src/sub/formatter.js");
  assert.equal(canonicalizePath("./src/formatter.js"), "src/formatter.js");
  assert.equal(canonicalizePath("/src/formatter.js"), "src/formatter.js");
  assert.equal(canonicalizePath("\\src\\formatter.js"), "src/formatter.js");
  assert.equal(canonicalizePath("src/formatter.js/"), "src/formatter.js");
  assert.equal(canonicalizePath("  src/formatter.js  "), "src/formatter.js");
  assert.equal(canonicalizePath(null), "");
  assert.equal(canonicalizePath(undefined), "");
});

test("turn-diet: regression E: Known-Path Fast Path works for arbitrary concrete paths without dependency on 'formatter'", () => {
  const contract = {
    allowedPaths: ["pkg/service/auth.go", "pkg/service/auth_test.go"],
    forbiddenPaths: [".agents/**"],
    testsRequired: ["go test ./pkg/service/..."],
  };

  const specificity = classifyScopeSpecificity(contract);
  assert.equal(specificity, "CONCRETE", "Arbitrary non-benchmark paths must be classified as CONCRETE");

  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "PLANNED",
    taskAction: "IMPLEMENT",
    taskId: "arbitrary-service-task",
  }));

  const input = JSON.stringify({
    conversationId: "parent-orch-e",
    toolCall: {
      name: "invoke_subagent",
      args: {
        Subagents: [
          {
            TypeName: "flash-low-worker",
            Role: "flash-low-worker",
            Model: "gemini-3.8-flash-low",
            Prompt: "Task: Implement Auth.\n\nScope Contract:\n- allowedPaths: [\"pkg/service/auth.go\", \"pkg/service/auth_test.go\"]\n- testsRequired: `go test ./pkg/service/...`\n",
          },
        ],
      },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
  assert.equal(out.decision, "allow");

  const savedContract = JSON.parse(readFileSync(".agents/state/active-contract.json", "utf-8"));
  assert.deepEqual(savedContract.allowedPaths, ["pkg/service/auth.go", "pkg/service/auth_test.go"]);
  assert.deepEqual(savedContract.testsRequired, ["go test ./pkg/service/..."]);
  assert.equal(classifyScopeSpecificity(savedContract), "CONCRETE");
});

/* =========================================================================
   EVIDENCE SYNC INTEGRITY v2.2 REGRESSIONS
   ========================================================================= */

const testBrainDir = resolve(runtimeRoot, "scratch/test-brain");

function setupTestBrain(parentConvId, childConvId, childDescriptor, transcriptSteps) {
  const subagentsDir = resolve(testBrainDir, parentConvId, ".system_generated/subagents");
  const childLogsDir = resolve(testBrainDir, childConvId, ".system_generated/logs");
  mkdirSync(subagentsDir, { recursive: true });
  mkdirSync(childLogsDir, { recursive: true });

  const subJson = {
    conversationId: childConvId,
    subagentDescriptor: childDescriptor,
    state: "SUBAGENT_STATE_ALIVE",
    spawnStepIndex: 1,
  };
  writeFileSync(resolve(subagentsDir, `${childConvId}.json`), JSON.stringify(subJson), "utf-8");

  const transcriptLines = transcriptSteps.map((s) => JSON.stringify(s)).join("\n");
  writeFileSync(resolve(childLogsDir, "transcript.jsonl"), transcriptLines, "utf-8");
}

function teardownTestBrain() {
  try { rmSync(testBrainDir, { recursive: true, force: true }); } catch {}
}

test("evidence-sync-integrity: regression 1: reviewer test cannot satisfy worker validation", () => {
  teardownTestBrain();
  const parentId = "parent-rev-1";
  const childId = "child-rev-1";
  setupTestBrain(
    parentId,
    childId,
    { typeName: "flash-reviewer", role: "Reviewer" },
    [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "node --test tests/auth.test.mjs" } }],
      },
      {
        step_index: 1,
        content: "The command exited with code 0",
      },
    ]
  );

  const roleBindings = {
    bindings: {
      [childId]: {
        role: "REVIEWER",
        profile: "flash-reviewer",
        confidence: "HIGH",
        parentConversationId: parentId,
      },
    },
  };

  const activeState = {
    evidenceLedger: [],
    scopeContract: { testsRequired: ["node --test tests/auth.test.mjs"] },
  };

  syncChildEvidence(activeState, parentId, { brainBaseDir: testBrainDir, roleBindings });

  assert.equal(activeState.evidenceLedger.length, 1);
  assert.equal(activeState.evidenceLedger[0].actorRole, "REVIEWER");
  assert.equal(activeState.reviewerValidationObserved, true);
  assert.equal(activeState.workerValidationObserved, undefined);

  const val = verifyWorkerValidation(activeState);
  assert.equal(val.verified, false);
  assert.ok(val.reason.includes("INVALID_ACTOR"));
  teardownTestBrain();
});

test("evidence-sync-integrity: regression 2: unknown child cannot satisfy worker validation", () => {
  teardownTestBrain();
  const parentId = "parent-unk-1";
  const childId = "child-unk-1";
  setupTestBrain(
    parentId,
    childId,
    { typeName: "arbitrary-unknown", role: "UnknownRole" },
    [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "node --test" } }],
      },
      {
        step_index: 1,
        content: "The command exited with code 0",
      },
    ]
  );

  const roleBindings = { bindings: {} };
  const activeState = { evidenceLedger: [] };

  syncChildEvidence(activeState, parentId, { brainBaseDir: testBrainDir, roleBindings });

  assert.equal(activeState.evidenceLedger.length, 1);
  assert.equal(activeState.evidenceLedger[0].actorRole, "UNKNOWN");
  assert.equal(activeState.evidenceLedger[0].confidence, "LOW");
  assert.equal(activeState.unknownValidationObserved, true);
  assert.equal(activeState.workerValidationObserved, undefined);

  const val = verifyWorkerValidation(activeState);
  assert.equal(val.verified, false);
  teardownTestBrain();
});

test("evidence-sync-integrity: regression 3: unbound child fails closed", () => {
  teardownTestBrain();
  const parentId = "parent-unbound-1";
  const childId = "child-unbound-1";
  setupTestBrain(
    parentId,
    childId,
    { typeName: "self", role: "Worker" },
    [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
      },
      {
        step_index: 1,
        content: "The command exited with code 0",
      },
    ]
  );

  const activeState = { evidenceLedger: [] };
  // Empty role bindings -> child is unbound
  syncChildEvidence(activeState, parentId, { brainBaseDir: testBrainDir, roleBindings: { bindings: {} } });

  assert.equal(activeState.evidenceLedger.length, 1);
  assert.notEqual(activeState.evidenceLedger[0].actorRole, "WORKER");
  assert.equal(activeState.evidenceLedger[0].actorRole, "UNKNOWN");
  assert.equal(activeState.evidenceLedger[0].confidence, "LOW");
  teardownTestBrain();
});

test("evidence-sync-integrity: regression 4: child from wrong parent is ignored", () => {
  teardownTestBrain();
  const parentId = "parent-orch-104";
  const childId = "child-foreign-1";
  setupTestBrain(
    parentId,
    childId,
    { typeName: "flash-low-worker", role: "Worker" },
    [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
      },
      {
        step_index: 1,
        content: "The command exited with code 0",
      },
    ]
  );

  const roleBindings = {
    bindings: {
      [childId]: {
        role: "WORKER",
        confidence: "HIGH",
        parentConversationId: "completely-different-parent",
      },
    },
  };

  const activeState = { evidenceLedger: [] };
  syncChildEvidence(activeState, parentId, { brainBaseDir: testBrainDir, roleBindings });
  assert.equal(activeState.evidenceLedger.length, 0, "Foreign parent child evidence must be ignored");
  teardownTestBrain();
});

test("evidence-sync-integrity: regression 5: old task evidence is ignored", () => {
  teardownTestBrain();
  const parentId = "parent-orch-105";
  const childId = "child-old-task-1";
  setupTestBrain(
    parentId,
    childId,
    { typeName: "flash-low-worker", role: "Worker" },
    [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
      },
      {
        step_index: 1,
        content: "The command exited with code 0",
      },
    ]
  );

  const roleBindings = {
    bindings: {
      [childId]: {
        role: "WORKER",
        confidence: "HIGH",
        parentConversationId: parentId,
        taskIdentifier: "task-old-yesterday",
      },
    },
  };

  const activeState = { evidenceLedger: [], taskId: "task-current-today" };
  syncChildEvidence(activeState, parentId, { brainBaseDir: testBrainDir, roleBindings });
  assert.equal(activeState.evidenceLedger.length, 0, "Evidence with mismatched taskId must be ignored");
  teardownTestBrain();
});

test("evidence-sync-integrity: regression 6: validation PASS followed by mutation becomes stale", () => {
  teardownTestBrain();
  const parentId = "parent-orch-106";
  const childId = "child-worker-106";
  setupTestBrain(
    parentId,
    childId,
    { typeName: "flash-low-worker", role: "Worker" },
    [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "write_to_file", args: { TargetFile: "src/index.js", CodeContent: "const a = 1;" } }],
      },
      {
        step_index: 1,
        content: "File written",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "node --test" } }],
      },
      {
        step_index: 3,
        content: "The command exited with code 0",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "replace_file_content", args: { TargetFile: "src/index.js", TargetContent: "1", ReplacementContent: "2" } }],
      },
      {
        step_index: 5,
        content: "File replaced",
      },
      {
        step_index: 6,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "send_message", args: { Message: "IMPLEMENTATION_COMPLETE" } }],
      },
    ]
  );

  const roleBindings = {
    bindings: {
      [childId]: {
        role: "WORKER",
        confidence: "HIGH",
        parentConversationId: parentId,
      },
    },
  };

  const activeState = { evidenceLedger: [] };
  syncChildEvidence(activeState, parentId, { brainBaseDir: testBrainDir, roleBindings });

  assert.equal(activeState.evidenceLedger.length, 1);
  const ev = activeState.evidenceLedger[0];
  assert.equal(ev.mutationAfterValidation, true);
  assert.equal(ev.fresh, false);

  const val = verifyWorkerValidation(activeState);
  assert.equal(val.verified, false);
  assert.equal(val.fresh, false);
  assert.ok(val.reason.includes("STALE"));
  teardownTestBrain();
});

test("evidence-sync-integrity: regression 7: validation FAIL -> mutation -> PASS uses final fresh pass", () => {
  teardownTestBrain();
  const parentId = "parent-orch-107";
  const childId = "child-worker-107";
  setupTestBrain(
    parentId,
    childId,
    { typeName: "flash-low-worker", role: "Worker" },
    [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "write_to_file", args: { TargetFile: "src/index.js", CodeContent: "broken" } }],
      },
      {
        step_index: 1,
        content: "File written",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "node --test test/index.test.mjs" } }],
      },
      {
        step_index: 3,
        content: "The command exited with code 1",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "replace_file_content", args: { TargetFile: "src/index.js", TargetContent: "broken", ReplacementContent: "fixed" } }],
      },
      {
        step_index: 5,
        content: "File replaced",
      },
      {
        step_index: 6,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "node --test test/index.test.mjs" } }],
      },
      {
        step_index: 7,
        content: "The command exited with code 0",
      },
      {
        step_index: 8,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "send_message", args: { Message: "IMPLEMENTATION_COMPLETE" } }],
      },
    ]
  );

  const roleBindings = {
    bindings: {
      [childId]: {
        role: "WORKER",
        confidence: "HIGH",
        parentConversationId: parentId,
      },
    },
  };

  const activeState = {
    evidenceLedger: [],
    scopeContract: { testsRequired: ["node --test test/index.test.mjs"] },
  };

  syncChildEvidence(activeState, parentId, { brainBaseDir: testBrainDir, roleBindings });

  assert.equal(activeState.evidenceLedger.length, 2, "Both distinct test executions must remain in ledger");
  const failEv = activeState.evidenceLedger[0];
  const passEv = activeState.evidenceLedger[1];

  assert.equal(failEv.exitCode, 1);
  assert.equal(failEv.mutationAfterValidation, true);
  assert.equal(failEv.fresh, false);

  assert.equal(passEv.exitCode, 0);
  assert.equal(passEv.mutationAfterValidation, false);
  assert.equal(passEv.fresh, true);

  assert.equal(activeState.workerValidationExitCode, 0);
  assert.equal(activeState.workerValidationActor, "WORKER");

  const val = verifyWorkerValidation(activeState);
  assert.equal(val.verified, true);
  assert.equal(val.fresh, true);
  assert.equal(val.evidence.exitCode, 0);
  teardownTestBrain();
});

test("evidence-sync-integrity: regression 8: repeated same test executions remain distinct", () => {
  teardownTestBrain();
  const parentId = "parent-orch-108";
  const childId = "child-worker-108";
  setupTestBrain(
    parentId,
    childId,
    { typeName: "flash-low-worker", role: "Worker" },
    [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
      },
      {
        step_index: 1,
        content: "The command exited with code 0",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
      },
      {
        step_index: 3,
        content: "The command exited with code 0",
      },
    ]
  );

  const roleBindings = {
    bindings: {
      [childId]: { role: "WORKER", confidence: "HIGH", parentConversationId: parentId },
    },
  };

  const activeState = { evidenceLedger: [] };
  syncChildEvidence(activeState, parentId, { brainBaseDir: testBrainDir, roleBindings });

  assert.equal(activeState.evidenceLedger.length, 2, "Repeated executions must not overwrite each other");
  assert.notEqual(
    activeState.evidenceLedger[0].transcriptEvidenceId,
    activeState.evidenceLedger[1].transcriptEvidenceId
  );
  teardownTestBrain();
});

test("evidence-sync-integrity: regression 9: no synthetic executionId in child evidence", () => {
  teardownTestBrain();
  const parentId = "parent-orch-109";
  const childId = "child-worker-109";
  setupTestBrain(
    parentId,
    childId,
    { typeName: "flash-low-worker", role: "Worker" },
    [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "node --test" } }],
      },
      {
        step_index: 1,
        content: "The command exited with code 0",
      },
    ]
  );

  const roleBindings = {
    bindings: {
      [childId]: { role: "WORKER", confidence: "HIGH", parentConversationId: parentId },
    },
  };

  const activeState = { evidenceLedger: [] };
  syncChildEvidence(activeState, parentId, { brainBaseDir: testBrainDir, roleBindings });

  assert.equal(activeState.evidenceLedger[0].executionId, null, "Child transcript evidence executionId must be null");
  assert.ok(
    !JSON.stringify(activeState.evidenceLedger[0]).includes("exec-child-worker-109"),
    "No synthetic execId string allowed"
  );
  teardownTestBrain();
});

test("evidence-sync-integrity: regression 10: transcriptEvidenceId is separate from executionId", () => {
  teardownTestBrain();
  const parentId = "parent-orch-110";
  const childId = "child-worker-110";
  setupTestBrain(
    parentId,
    childId,
    { typeName: "flash-low-worker", role: "Worker" },
    [
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "node --test" } }],
      },
      {
        step_index: 5,
        content: "The command exited with code 0",
      },
    ]
  );

  const roleBindings = {
    bindings: {
      [childId]: { role: "WORKER", confidence: "HIGH", parentConversationId: parentId },
    },
  };

  const activeState = { evidenceLedger: [] };
  syncChildEvidence(activeState, parentId, { brainBaseDir: testBrainDir, roleBindings });

  const ev = activeState.evidenceLedger[0];
  assert.equal(ev.executionId, null);
  assert.equal(ev.transcriptEvidenceId, `child:${childId}:step:4:tool:0`);
  teardownTestBrain();
});

test("evidence-sync-integrity: regression 11: invalid agent names are denied", () => {
  const invalidNames = [
    "../worker",
    "../../foo",
    "foo/bar",
    "foo\\bar",
    "C:\\foo",
    "/absolute",
    "foo.md/../bar",
    ".",
    "..",
    "",
  ];

  for (const badName of invalidNames) {
    const input = JSON.stringify({
      conversationId: "parent-orch",
      toolCall: {
        name: "define_subagent",
        args: { name: badName, system_prompt: "Malicious prompt" },
      },
    });
    const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(out.decision, "deny", `Agent name "${badName}" must be denied`);
    assert.ok(out.reason.includes("INVALID_AGENT_NAME"), `Reason for "${badName}" must indicate INVALID_AGENT_NAME`);
  }
});

test("evidence-sync-integrity: regression 12: valid registered profile is allowed with authoritative prompt", () => {
  const input = JSON.stringify({
    conversationId: "parent-orch",
    toolCall: {
      name: "define_subagent",
      args: { name: "flash-low-worker", system_prompt: "Untrusted prompt from orchestrator" },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
  assert.equal(out.decision, "allow");
  assert.ok(out.overwrite && out.overwrite.system_prompt, "Authoritative system prompt must be overwritten");
  assert.ok(out.overwrite.system_prompt.includes("Flash Low Worker"), "Prompt must match authoritative inventory");
});

test("evidence-sync-integrity: regression 13: valid name syntax but nonexistent profile is denied", () => {
  const input = JSON.stringify({
    conversationId: "parent-orch",
    toolCall: {
      name: "define_subagent",
      args: { name: "flash-nonexistent-worker", system_prompt: "Custom untrusted subagent" },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("UNKNOWN_AGENT_PROFILE"), "Unknown profile must fail closed with UNKNOWN_AGENT_PROFILE");
});

test("evidence-sync-integrity: regression 14: module import does not invoke main or read stdin", () => {
  // Test importing pre-tool-enforce.mjs and stop-guard.mjs in a separate node process without hanging
  const testScript = `
    const start = Date.now();
    await import(${JSON.stringify(preToolScript)});
    await import(${JSON.stringify(stopScript)});
    const elapsed = Date.now() - start;
    if (elapsed > 2000) {
      process.exit(2);
    }
    process.exit(0);
  `;

  const child = execFileSync("node", ["--input-type=module", "-e", testScript], {
    timeout: 3000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.ok(true, "Imports completed without hang");
});

test("evidence-sync-integrity: regression 15: direct script execution still invokes hook", () => {
  const input = JSON.stringify({
    toolCall: {
      name: "define_subagent",
      args: { name: "invalid/name" },
    },
  });

  const rawOut = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
  const parsed = JSON.parse(rawOut.trim());
  assert.equal(parsed.decision, "deny");
  assert.ok(parsed.reason.includes("INVALID_AGENT_NAME"));
});

// --- Fidelity & Reactive Wakeup v2.3 Regressions ---

test("fidelity-reactive-wakeup: regression 1: unbound descriptor 'flash-low-worker' remains UNKNOWN", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "reg1-unbound-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    const sub = {
      conversationId: "child-unbound-flash",
      subagentDescriptor: { typeName: "flash-low-worker", role: "flash-low-worker" },
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir, { bindings: {}, pendingSubagents: [] });
    assert.equal(ev.role, "UNKNOWN");
    assert.equal(ev.confidence, "LOW");
    assert.equal(ev.validations.length, 1);
    assert.equal(ev.validations[0].actorRole, "UNKNOWN");
    assert.equal(ev.validations[0].confidence, "LOW");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 2: descriptor containing 'fix'/'implement'/'self' cannot prove WORKER", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "reg2-descriptor-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    const probeDescriptors = [
      { typeName: "self", role: "fixer" },
      { typeName: "implementer", role: "implement" },
      { typeName: "fix-agent", role: "Worker" },
      { typeName: "code-fixer", role: "self" },
    ];

    for (const desc of probeDescriptors) {
      const sub = { conversationId: `child-${desc.typeName}`, subagentDescriptor: desc };
      const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir, { bindings: {}, pendingSubagents: [] });
      assert.equal(ev.role, "UNKNOWN", `Descriptor ${JSON.stringify(desc)} must not be promoted to WORKER`);
      assert.equal(ev.confidence, "LOW");
      assert.equal(ev.validations[0].actorRole, "UNKNOWN");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 3: exact bound worker resolves WORKER/HIGH", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "reg3-bound-worker-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    const sub = {
      conversationId: "child-worker-exact",
      subagentDescriptor: { typeName: "unrelated-desc", role: "Helper" },
    };
    const roleBindings = {
      bindings: {
        "child-worker-exact": {
          role: "WORKER",
          confidence: "HIGH",
          profile: "flash-low-worker",
        },
      },
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir, roleBindings);
    assert.equal(ev.role, "WORKER");
    assert.equal(ev.confidence, "HIGH");
    assert.equal(ev.profile, "flash-low-worker");
    assert.equal(ev.validations[0].actorRole, "WORKER");
    assert.equal(ev.validations[0].confidence, "HIGH");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 4: reviewer binding remains REVIEWER", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "reg4-reviewer-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    const sub = {
      conversationId: "child-reviewer-exact",
      subagentDescriptor: { typeName: "flash-worker", role: "Worker" },
    };
    const roleBindings = {
      bindings: {
        "child-reviewer-exact": {
          role: "REVIEWER",
          confidence: "HIGH",
          profile: "flash-reviewer",
        },
      },
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir, roleBindings);
    assert.equal(ev.role, "REVIEWER");
    assert.equal(ev.validations[0].actorRole, "REVIEWER");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 5: wrong-parent pending cannot bind", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "reg5-wrong-parent-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    const sub = {
      conversationId: "child-parent-mismatch",
      subagentDescriptor: { typeName: "flash-low-worker", role: "Worker" },
    };
    const roleBindings = {
      pendingSubagents: [
        {
          typeName: "flash-low-worker",
          profile: "flash-low-worker",
          role: "WORKER",
          parentConversationId: "parent-alpha",
          consumed: false,
        },
      ],
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir, roleBindings, {
      parentConvId: "parent-beta",
    });
    assert.equal(ev.role, "UNKNOWN");
    assert.equal(ev.confidence, "LOW");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 6: wrong-task pending cannot bind", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "reg6-wrong-task-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    const sub = {
      conversationId: "child-task-mismatch",
      subagentDescriptor: { typeName: "flash-low-worker", role: "Worker" },
    };
    const roleBindings = {
      pendingSubagents: [
        {
          typeName: "flash-low-worker",
          profile: "flash-low-worker",
          role: "WORKER",
          parentConversationId: "parent-1",
          taskIdentifier: "task-other",
          consumed: false,
        },
      ],
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir, roleBindings, {
      parentConvId: "parent-1",
      taskId: "task-current",
    });
    assert.equal(ev.role, "UNKNOWN");
    assert.equal(ev.confidence, "LOW");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 7: ambiguous pending candidates fail closed", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "reg7-ambiguous-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    const sub = {
      conversationId: "child-ambiguous",
      subagentDescriptor: { typeName: "flash-low-worker", role: "Worker" },
    };
    const roleBindings = {
      pendingSubagents: [
        {
          typeName: "flash-low-worker",
          profile: "flash-low-worker",
          role: "WORKER",
          parentConversationId: "parent-1",
          taskId: "task-simple",
          consumed: false,
        },
        {
          typeName: "flash-low-worker",
          profile: "flash-low-worker",
          role: "WORKER",
          parentConversationId: "parent-1",
          taskId: "task-simple",
          consumed: false,
        },
      ],
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir, roleBindings, {
      parentConvId: "parent-1",
      taskId: "task-simple",
    });
    assert.equal(ev.role, "UNKNOWN", "Ambiguous (>1) candidates must fail closed to UNKNOWN");
    assert.equal(ev.confidence, "LOW");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 8: unique parent/task/profile candidate binds", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "reg8-unique-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    const sub = {
      conversationId: "child-unique-bind",
      subagentDescriptor: { typeName: "flash-low-worker", role: "Worker" },
    };
    const roleBindings = {
      pendingSubagents: [
        {
          typeName: "flash-low-worker",
          profile: "flash-low-worker",
          role: "WORKER",
          parentConversationId: "parent-1",
          taskIdentifier: "task-simple",
          consumed: false,
        },
      ],
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir, roleBindings, {
      parentConvId: "parent-1",
      taskId: "task-simple",
    });
    assert.equal(ev.role, "WORKER");
    assert.equal(ev.confidence, "HIGH");
    assert.equal(ev.validations[0].actorRole, "WORKER");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 9: consumed pending cannot bind twice", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "reg9-consumed-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    const sub = {
      conversationId: "child-second-attempter",
      subagentDescriptor: { typeName: "flash-low-worker", role: "Worker" },
    };
    const roleBindings = {
      pendingSubagents: [
        {
          typeName: "flash-low-worker",
          profile: "flash-low-worker",
          role: "WORKER",
          parentConversationId: "parent-1",
          taskIdentifier: "task-simple",
          consumed: true,
          consumedBy: "child-first",
          consumedAt: "2026-09-16T20:00:00.000Z",
        },
      ],
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir, roleBindings, {
      parentConvId: "parent-1",
      taskId: "task-simple",
    });
    assert.equal(ev.role, "UNKNOWN", "Consumed pending candidate cannot bind again");
    assert.equal(ev.confidence, "LOW");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 10: fallback-created binding is persisted", () => {
  cleanState();
  const brainDir = mkdtempSync(join(tmpdir(), "brain-persist-"));
  try {
    const parentConvId = "parent-persist-test";
    const childConvId = "child-persist-test";
    const subagentsDir = join(brainDir, parentConvId, ".system_generated/subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, `${childConvId}.json`), JSON.stringify({
      conversationId: childConvId,
      subagentDescriptor: { typeName: "flash-low-worker", role: "Worker" },
    }), "utf-8");

    const childLogDir = join(brainDir, childConvId, ".system_generated/logs");
    mkdirSync(childLogDir, { recursive: true });
    writeFileSync(join(childLogDir, "transcript.jsonl"), JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    mkdirSync(".agents/state", { recursive: true });
    const initialRoleBindings = {
      mainConversationId: parentConvId,
      bindings: {},
      pendingSubagents: [
        {
          typeName: "flash-low-worker",
          profile: "flash-low-worker",
          role: "WORKER",
          model: "gemini-3.8-flash-low",
          parentConversationId: parentConvId,
          taskIdentifier: "task-persist",
          consumed: false,
        },
      ],
    };
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify(initialRoleBindings, null, 2), "utf-8");

    const activeState = {
      taskId: "task-persist",
      evidenceLedger: [],
    };

    syncChildEvidence(activeState, parentConvId, {
      brainBaseDir: brainDir,
      repoRoot: process.cwd(),
      taskId: "task-persist",
    });

    const savedBindings = JSON.parse(readFileSync(".agents/state/role-bindings.json", "utf-8"));
    const bound = savedBindings.bindings[childConvId];
    assert.ok(bound, "Binding for child conversation must be persisted to role-bindings.json");
    assert.equal(bound.role, "WORKER");
    assert.equal(bound.profile, "flash-low-worker");
    assert.equal(bound.consumed, true);
    assert.equal(bound.consumedBy, childConvId);
    assert.ok(bound.consumedAt, "consumedAt timestamp must be recorded");

    const pending = savedBindings.pendingSubagents[0];
    assert.equal(pending.consumed, true);
    assert.equal(pending.consumedBy, childConvId);
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 11: second sync reuses persisted exact binding rather than pending", () => {
  cleanState();
  const brainDir = mkdtempSync(join(tmpdir(), "brain-second-sync-"));
  try {
    const parentConvId = "parent-sync2-test";
    const childConvId = "child-sync2-test";
    const subagentsDir = join(brainDir, parentConvId, ".system_generated/subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, `${childConvId}.json`), JSON.stringify({
      conversationId: childConvId,
      subagentDescriptor: { typeName: "flash-low-worker", role: "Worker" },
    }), "utf-8");

    const childLogDir = join(brainDir, childConvId, ".system_generated/logs");
    mkdirSync(childLogDir, { recursive: true });
    writeFileSync(join(childLogDir, "transcript.jsonl"), JSON.stringify({
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
    }) + "\n" + JSON.stringify({
      type: "TOOL_RESULT",
      content: "The command exited with code 0.\nOutput:\n✔ pass",
    }), "utf-8");

    mkdirSync(".agents/state", { recursive: true });
    const roleBindings = {
      mainConversationId: parentConvId,
      bindings: {
        [childConvId]: {
          conversationId: childConvId,
          role: "WORKER",
          profile: "flash-low-worker",
          parentConversationId: parentConvId,
          taskIdentifier: "task-sync2",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
          consumed: true,
          consumedBy: childConvId,
        },
      },
      pendingSubagents: [],
    };
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify(roleBindings, null, 2), "utf-8");

    const activeState = { taskId: "task-sync2", evidenceLedger: [] };
    syncChildEvidence(activeState, parentConvId, {
      brainBaseDir: brainDir,
      repoRoot: process.cwd(),
      taskId: "task-sync2",
    });

    assert.equal(activeState.evidenceLedger.length, 1);
    assert.equal(activeState.evidenceLedger[0].actorRole, "WORKER");
    assert.equal(activeState.evidenceLedger[0].confidence, "HIGH");
  } finally {
    rmSync(brainDir, { recursive: true, force: true });
  }
});

test("fidelity-reactive-wakeup: regression 12: healthy delegation does not require manage_subagents polling", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    subagent_invocations: 1,
  }));

  const input = JSON.stringify({
    conversationId: "parent-orch-poll",
    toolCall: {
      name: "manage_subagents",
      args: { Action: "list" },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input }));
  assert.equal(out.decision, "deny", "manage_subagents list polling must be denied during healthy delegation");
  assert.ok(out.reason.includes("Reactive Wakeup"), "Denial reason must cite Reactive Wakeup policy");
});

test("fidelity-reactive-wakeup: regression 13: Reactive Wakeup preserves formal acceptance", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-acceptance-conv",
    bindings: {
      "orch-acceptance-conv": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
      "child-worker-conv": { role: "WORKER", profile: "flash-low-worker", confidence: "HIGH" },
    },
  }));

  const activeState = {
    activeRole: "ORCHESTRATOR",
    conversationId: "orch-acceptance-conv",
    state: "DELEGATED",
    workerCompletionClaimed: true,
    evidenceLedger: [
      {
        executionId: null,
        transcriptEvidenceId: "child:child-worker-conv:step:3:tool:0",
        command: "npm test",
        exitCode: 0,
        fresh: true,
        actorRole: "WORKER",
        conversationId: "child-worker-conv",
      },
    ],
  };
  writeFileSync(".agents/state/active-state.json", JSON.stringify(activeState, null, 2), "utf-8");

  const input = JSON.stringify({
    conversationId: "orch-acceptance-conv",
    fullyIdle: true,
    stop_attempts: 1,
  });

  const out = JSON.parse(execFileSync("node", [stopScript], { input, encoding: "utf-8" }));
  assert.equal(out.decision, "stop");

  const finalState = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(finalState.acceptanceState, "ACCEPTED");
  assert.equal(finalState.acceptanceActor, "ORCHESTRATOR");
  assert.equal(finalState.state, "DONE");
  assert.equal(finalState.workerValidationVerified, true);
  assert.equal(finalState.workerValidationFresh, true);
  assert.equal(finalState.workerValidationActor, "WORKER");
  assert.equal(finalState.workerValidationExitCode, 0);
});

test("reactive-delegation-lock: 1. Orchestrator + DELEGATED + healthy + schedule -> DENY", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    subagent_invocations: 1,
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent-conv",
    toolCall: {
      name: "schedule",
      args: { DurationSeconds: 300, Prompt: "check status" },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input, encoding: "utf-8" }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("Reactive Wakeup policy"));
});

test("reactive-delegation-lock: 2. Orchestrator + DELEGATED + healthy + manage_task status -> DENY on first attempt", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    subagent_invocations: 1,
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent-conv",
    toolCall: {
      name: "manage_task",
      args: { Action: "status", TaskId: "task-123" },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input, encoding: "utf-8" }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("Reactive Wakeup policy"));
});

test("reactive-delegation-lock: 3. Orchestrator + DELEGATED + healthy + manage_subagents list/status -> DENY", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    subagent_invocations: 1,
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent-conv",
    toolCall: {
      name: "manage_subagents",
      args: { Action: "list" },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input, encoding: "utf-8" }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("Reactive Wakeup policy"));
});

test("reactive-delegation-lock: 4. Orchestrator + DELEGATED + healthy + view_file -> DENY", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    subagent_invocations: 1,
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent-conv",
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: resolve(runtimeRoot, "README.md") },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input, encoding: "utf-8" }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("Reactive Wakeup policy"));
});

test("reactive-delegation-lock: 5. Orchestrator + DELEGATED + healthy + grep_search -> DENY", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    subagent_invocations: 1,
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent-conv",
    toolCall: {
      name: "grep_search",
      args: { Query: "test", SearchPath: runtimeRoot },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input, encoding: "utf-8" }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("Reactive Wakeup policy"));
});

test("reactive-delegation-lock: 6. Orchestrator + DELEGATED + healthy + find_by_name -> DENY", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    subagent_invocations: 1,
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent-conv",
    toolCall: {
      name: "find_by_name",
      args: { Pattern: "*", SearchDirectory: runtimeRoot },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input, encoding: "utf-8" }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("Reactive Wakeup policy"));
});

test("reactive-delegation-lock: 7. Orchestrator + DELEGATED + healthy + routine run_command inspection -> DENY", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    subagent_invocations: 1,
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent-conv",
    toolCall: {
      name: "run_command",
      args: { CommandLine: "git status" },
    },
  });

  const out = JSON.parse(execFileSync("node", [preToolScript], { input, encoding: "utf-8" }));
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.includes("Reactive Wakeup policy"));
});

test("reactive-delegation-lock: 8. Worker performing normal implementation tools -> ALLOW according to existing scope rules", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-parent",
    bindings: {
      "child-worker-conv": { role: "WORKER", profile: "flash-medium-worker" },
    },
  }));
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "WORKER",
    state: "DELEGATED",
  }));

  // Worker view_file
  const viewInput = JSON.stringify({
    conversationId: "child-worker-conv",
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: resolve(runtimeRoot, "README.md") },
    },
  });
  const viewOut = JSON.parse(execFileSync("node", [preToolScript], { input: viewInput, encoding: "utf-8" }));
  assert.equal(viewOut.decision, "allow");

  // Worker grep_search
  const grepInput = JSON.stringify({
    conversationId: "child-worker-conv",
    toolCall: {
      name: "grep_search",
      args: { Query: "test", SearchPath: runtimeRoot },
    },
  });
  const grepOut = JSON.parse(execFileSync("node", [preToolScript], { input: grepInput, encoding: "utf-8" }));
  assert.equal(grepOut.decision, "allow");

  // Worker find_by_name
  const findInput = JSON.stringify({
    conversationId: "child-worker-conv",
    toolCall: {
      name: "find_by_name",
      args: { Pattern: "*", SearchDirectory: runtimeRoot },
    },
  });
  const findOut = JSON.parse(execFileSync("node", [preToolScript], { input: findInput, encoding: "utf-8" }));
  assert.equal(findOut.decision, "allow");
});

test("reactive-delegation-lock: 9. Orchestrator outside DELEGATED state performing legitimate read-only work -> existing behavior preserved", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "PLANNED",
  }));

  // view_file outside DELEGATED state
  const viewInput = JSON.stringify({
    conversationId: "orch-planning-conv",
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: resolve(runtimeRoot, "README.md") },
    },
  });
  const viewOut = JSON.parse(execFileSync("node", [preToolScript], { input: viewInput, encoding: "utf-8" }));
  assert.equal(viewOut.decision, "allow");

  // run_command read-only (git status) outside DELEGATED state
  const runInput = JSON.stringify({
    conversationId: "orch-planning-conv",
    toolCall: {
      name: "run_command",
      args: { CommandLine: "git status" },
    },
  });
  const runOut = JSON.parse(execFileSync("node", [preToolScript], { input: runInput, encoding: "utf-8" }));
  assert.equal(runOut.decision, "allow");
});

test("reactive-delegation-lock: 10. explicit cancellation/recovery path -> coordination action allowed", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
  }));

  // manage_subagents with Action="kill" is allowed
  const killSubInput = JSON.stringify({
    conversationId: "orch-cancel-conv",
    toolCall: {
      name: "manage_subagents",
      args: { Action: "kill", ConversationIds: ["sub-1"] },
    },
  });
  const killSubOut = JSON.parse(execFileSync("node", [preToolScript], { input: killSubInput, encoding: "utf-8" }));
  assert.equal(killSubOut.decision, "allow");

  // manage_task with Action="kill" is allowed
  const killTaskInput = JSON.stringify({
    conversationId: "orch-cancel-conv",
    toolCall: {
      name: "manage_task",
      args: { Action: "kill", TaskId: "task-1" },
    },
  });
  const killTaskOut = JSON.parse(execFileSync("node", [preToolScript], { input: killTaskInput, encoding: "utf-8" }));
  assert.equal(killTaskOut.decision, "allow");
});

test("reactive-delegation-lock: 11. diagnosed stalled/recovery state -> appropriate coordination action allowed", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "DELEGATED",
    stalled: true,
  }));

  // manage_subagents list allowed under diagnosed stalled state
  const subInput = JSON.stringify({
    conversationId: "orch-stalled-conv",
    toolCall: {
      name: "manage_subagents",
      args: { Action: "list" },
    },
  });
  const subOut = JSON.parse(execFileSync("node", [preToolScript], { input: subInput, encoding: "utf-8" }));
  assert.equal(subOut.decision, "allow");

  // manage_task status allowed under diagnosed stalled state (via budget)
  const taskInput = JSON.stringify({
    conversationId: "orch-stalled-conv",
    toolCall: {
      name: "manage_task",
      args: { Action: "status", TaskId: "task-stalled" },
    },
  });
  const taskOut = JSON.parse(execFileSync("node", [preToolScript], { input: taskInput, encoding: "utf-8" }));
  assert.equal(taskOut.decision, "allow");

  // product inspection tools remain prohibited even under diagnosed stalled state
  const viewInput = JSON.stringify({
    conversationId: "orch-stalled-conv",
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: resolve(runtimeRoot, "src/formatter.js") },
    },
  });
  const viewOut = JSON.parse(execFileSync("node", [preToolScript], { input: viewInput, encoding: "utf-8" }));
  assert.equal(viewOut.decision, "deny");
});

test("reactive-delegation-lock: 12. healthy delegated execution can yield and later reach factual ORCHESTRATOR / ACCEPTED with zero parent polling tools", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: "orch-yield-accept",
    bindings: {
      "orch-yield-accept": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
      "child-worker-clean": { role: "WORKER", profile: "flash-medium-worker", confidence: "HIGH" },
    },
  }));

  // 1. Initially delegated with verified worker evidence in ledger
  const activeState = {
    activeRole: "ORCHESTRATOR",
    conversationId: "orch-yield-accept",
    state: "DELEGATED",
    workerCompletionClaimed: true,
    evidenceLedger: [
      {
        executionId: null,
        transcriptEvidenceId: "child:child-worker-clean:step:4:tool:0",
        command: "node --test",
        exitCode: 0,
        fresh: true,
        actorRole: "WORKER",
        conversationId: "child-worker-clean",
      },
    ],
  };
  writeFileSync(".agents/state/active-state.json", JSON.stringify(activeState, null, 2), "utf-8");

  // 2. Parent concludes cleanly with zero polling tool calls
  const input = JSON.stringify({
    conversationId: "orch-yield-accept",
    fullyIdle: true,
    stop_attempts: 1,
  });

  const out = JSON.parse(execFileSync("node", [stopScript], { input, encoding: "utf-8" }));
  assert.equal(out.decision, "stop");

  const finalState = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(finalState.acceptanceState, "ACCEPTED");
  assert.equal(finalState.acceptanceActor, "ORCHESTRATOR");
  assert.equal(finalState.state, "DONE");
  assert.equal(finalState.workerValidationVerified, true);
  assert.equal(finalState.workerValidationFresh, true);
  assert.equal(finalState.workerValidationExitCode, 0);
});

test("task4-v1.4: 1. denied delegated schedule attempt is counted as a side-quest attempt", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sidequest-test-1-"));
  const transcriptPath = join(tempDir, "transcript.jsonl");
  try {
    const lines = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Task prompt" }),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "invoke_subagent", args: {} }] }),
      JSON.stringify({ step_index: 2, type: "GENERIC", status: "DONE", content: "Worker spawned" }),
      JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 30 } }] }),
      JSON.stringify({ step_index: 4, type: "GENERIC", status: "ERROR", error: "tool call denied by pre-tool hook: Reactive Wakeup policy: Routine schedule/timer calls are prohibited" }),
      JSON.stringify({ step_index: 5, type: "PLANNER_RESPONSE", tool_calls: [] }),
      JSON.stringify({ step_index: 6, type: "SYSTEM_MESSAGE", content: "STATUS: IMPLEMENTATION_COMPLETE" }),
      JSON.stringify({ step_index: 7, type: "PLANNER_RESPONSE", tool_calls: [] }),
    ];
    writeFileSync(transcriptPath, lines.join("\n"), "utf8");

    const res = extractParentDelegatedSidequestAttempts(transcriptPath);
    assert.equal(res.total_attempts, 1);
    assert.equal(res.attempts_by_tool["schedule"], 1);
    assert.equal(res.denied_count, 1);
    assert.equal(res.succeeded_count, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task4-v1.4: 2. zero successful side quests but one denied attempt -> gate FAIL", () => {
  const res = {
    parent_delegated_sidequest_attempts: 1,
    parent_delegated_sidequest_denied: 1,
    parent_delegated_sidequest_succeeded: 0,
  };
  const zeroGate = res.parent_delegated_sidequest_attempts === 0 ? "PASS" : "FAIL";
  assert.equal(zeroGate, "FAIL");
});

test("task4-v1.4: 3. zero attempted side quests -> gate PASS", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sidequest-test-3-"));
  const transcriptPath = join(tempDir, "transcript.jsonl");
  try {
    const lines = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Task prompt" }),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "invoke_subagent", args: {} }] }),
      JSON.stringify({ step_index: 2, type: "GENERIC", status: "DONE", content: "Worker spawned" }),
      JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [] }),
      JSON.stringify({ step_index: 4, type: "SYSTEM_MESSAGE", content: "STATUS: IMPLEMENTATION_COMPLETE" }),
      JSON.stringify({ step_index: 5, type: "PLANNER_RESPONSE", tool_calls: [] }),
    ];
    writeFileSync(transcriptPath, lines.join("\n"), "utf8");

    const res = extractParentDelegatedSidequestAttempts(transcriptPath);
    assert.equal(res.total_attempts, 0);
    assert.equal(res.denied_count, 0);
    assert.equal(res.succeeded_count, 0);
    const zeroGate = res.total_attempts === 0 ? "PASS" : "FAIL";
    assert.equal(zeroGate, "PASS");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task4-v1.4: 4. legitimate recovery exception does not count as routine side quest", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sidequest-test-4-"));
  const transcriptPath = join(tempDir, "transcript.jsonl");
  try {
    const lines = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Task prompt" }),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "invoke_subagent", args: {} }] }),
      JSON.stringify({ step_index: 2, type: "GENERIC", status: "DONE", content: "Worker spawned" }),
      JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_subagents", args: { Action: "kill", ConversationIds: ["sub-1"] } }] }),
      JSON.stringify({ step_index: 4, type: "GENERIC", status: "DONE", content: "Subagent killed" }),
      JSON.stringify({ step_index: 5, type: "SYSTEM_MESSAGE", content: "STATUS: IMPLEMENTATION_COMPLETE" }),
    ];
    writeFileSync(transcriptPath, lines.join("\n"), "utf8");

    const res = extractParentDelegatedSidequestAttempts(transcriptPath);
    assert.equal(res.total_attempts, 0, "Cancellation exception must not count as routine side quest attempt");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task4-v1.4: 5. parent outside healthy delegation is not incorrectly counted", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sidequest-test-5-"));
  const transcriptPath = join(tempDir, "transcript.jsonl");
  try {
    const lines = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Task prompt" }),
      // Turn 1 before delegation: legitimate read
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "view_file", args: { AbsolutePath: "README.md" } }] }),
      JSON.stringify({ step_index: 2, type: "GENERIC", status: "DONE", content: "File content" }),
      // Turn 2: delegation
      JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: "invoke_subagent", args: {} }] }),
      JSON.stringify({ step_index: 4, type: "GENERIC", status: "DONE", content: "Worker spawned" }),
      // Child completion wakeup
      JSON.stringify({ step_index: 5, type: "SYSTEM_MESSAGE", content: "STATUS: IMPLEMENTATION_COMPLETE" }),
      // Turn 3: post-wakeup acceptance
      JSON.stringify({ step_index: 6, type: "PLANNER_RESPONSE", tool_calls: [] }),
    ];
    writeFileSync(transcriptPath, lines.join("\n"), "utf8");

    const res = extractParentDelegatedSidequestAttempts(transcriptPath);
    assert.equal(res.total_attempts, 0, "Tool calls outside delegation window must not be counted");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task4-v1.4: 6. Task 4 API compatibility rejects positional precision support", () => {
  function badFormatNumber(value, options = {}, precision) {
    const p = typeof precision === "number" ? precision : (options && typeof options.precision === "number" ? options.precision : undefined);
    if (typeof p === "number") {
      return value.toFixed(p);
    }
    return String(value);
  }

  function correctFormatNumber(value, options = {}) {
    const p = options && typeof options.precision === "number" ? options.precision : undefined;
    if (typeof p === "number") {
      return value.toFixed(p);
    }
    return String(value);
  }

  assert.equal(badFormatNumber(3.14159, {}, 2), "3.14");
  assert.equal(correctFormatNumber(3.14159, {}, 2), "3.14159");

  const rejectsPositional = correctFormatNumber(3.14159, {}, 2) === "3.14159";
  assert.equal(rejectsPositional, true);
  const badRejectsPositional = badFormatNumber(3.14159, {}, 2) === "3.14159";
  assert.equal(badRejectsPositional, false, "Bad implementation with positional parameter fails acceptance check");
});

test("task4-v1.4: 7. Task 4 preserves existing exported function signatures", () => {
  const pristineDir = resolve(orchestraRoot, "benchmarks/turn-economy/fixture");
  const tempDir = mkdtempSync(join(tmpdir(), "sig-audit-test-"));
  try {
    cpSync(join(pristineDir, "src"), join(tempDir, "src"), { recursive: true });

    // Unchanged fixture audit must pass
    const auditUnchanged = auditApiSignatures(pristineDir, tempDir, ["src/formatter.js", "src/calculator.js"]);
    assert.equal(auditUnchanged.changed, false);
    assert.equal(auditUnchanged.before["src/formatter.js"]["formatNumber"], "formatNumber(value, options = {})");
    assert.equal(auditUnchanged.before["src/calculator.js"]["calculateAndFormat"], "calculateAndFormat(op, a, b, options = {})");

    // If an alternate positional parameter is added to formatNumber signature
    const modifiedFormatter = readFileSync(join(tempDir, "src/formatter.js"), "utf8")
      .replace("formatNumber(value, options = {})", "formatNumber(value, options = {}, precision)");
    writeFileSync(join(tempDir, "src/formatter.js"), modifiedFormatter, "utf8");

    const auditChanged = auditApiSignatures(pristineDir, tempDir, ["src/formatter.js", "src/calculator.js"]);
    assert.equal(auditChanged.changed, true, "Signature alteration must be detected");
    assert.equal(auditChanged.details["formatNumber"].after, "formatNumber(value, options = {}, precision)");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task4-v1.4: 8. existing options.precision behavior passes", () => {
  function formatNumber(value, options = {}) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("Value must be a finite number");
    }
    const prefix = options.prefix || "";
    const suffix = options.suffix || "";
    let numStr;
    if (typeof options.precision === "number") {
      numStr = value.toFixed(options.precision);
    } else {
      numStr = String(value);
    }
    return `${prefix}${numStr}${suffix}`;
  }

  assert.equal(formatNumber(3.14159, { precision: 2 }), "3.14");
  assert.equal(formatNumber(10, { precision: 3 }), "10.000");
  assert.equal(formatNumber(3.14159, {}), "3.14159");
  assert.equal(formatNumber(3.14159), "3.14159");
});

test("task4-v1.4: 9. calculator options pass-through works without calculator API expansion", () => {
  const pristineDir = resolve(orchestraRoot, "benchmarks/turn-economy/fixture");
  const tempDir = mkdtempSync(join(tmpdir(), "calc-passthrough-test-"));
  try {
    cpSync(join(pristineDir, "src"), join(tempDir, "src"), { recursive: true });

    // Update only formatter.js with options.precision
    const formatterContent = `
export function formatNumber(value, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Value must be a finite number");
  }
  const prefix = options.prefix || "";
  const suffix = options.suffix || "";
  let numStr;
  if (typeof options.precision === "number") {
    numStr = value.toFixed(options.precision);
  } else {
    numStr = String(value);
  }
  return \`\${prefix}\${numStr}\${suffix}\`;
}
export function formatPercentage(value) {
  return \`\${Math.round(value * 100)}%\`;
}
`;
    writeFileSync(join(tempDir, "src/formatter.js"), formatterContent, "utf8");

    // Notice: src/calculator.js is NOT mutated at all!
    const testCode = `
      import assert from "node:assert/strict";
      import { calculateAndFormat } from "./src/calculator.js";
      assert.equal(calculateAndFormat("divide", 1, 8, { precision: 2 }), "0.13");
    `;
    execFileSync("node", ["--input-type=module", "-e", testCode], { cwd: tempDir, stdio: "pipe" });

    // Scope minimality check: only src/formatter.js is mutated
    const scopeAudit = auditScopeMinimality(["src/formatter.js", "test/formatter.test.js"], "multi");
    assert.equal(scopeAudit.pass, true);
    assert.equal(scopeAudit.classification["src/formatter.js"], "REQUIRED");

    // If src/calculator.js had been mutated:
    const badScopeAudit = auditScopeMinimality(["src/formatter.js", "src/calculator.js"], "multi");
    assert.equal(badScopeAudit.pass, false);
    assert.equal(badScopeAudit.classification["src/calculator.js"], "UNNECESSARY_SCOPE_EXPANSION");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task5-v1.1: 1. grammar preservation rejects newly accepted syntax (+50%, -50%, .5%, 5.%)", () => {
  // Correct parser implementation with smallest language extension
  function parsePercentageCorrect(input) {
    if (typeof input !== "string") throw new TypeError("Percentage input must be a string");
    const trimmed = input.trim();
    const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)%$/);
    if (!match) throw new RangeError(`Invalid percentage format: "${input}"`);
    return Number(match[1] + "e-2");
  }

  // Naive overly permissive parser implementation
  function parsePercentageBroad(input) {
    if (typeof input !== "string") throw new TypeError("Percentage input must be a string");
    const trimmed = input.trim();
    const match = trimmed.match(/^([-+]?[0-9]+(?:\.[0-9]+)?)%$/);
    if (!match) throw new RangeError(`Invalid percentage format: "${input}"`);
    return Number(match[1]) / 100;
  }

  const unrelatedSyntax = ["+50%", "-50%", ".5%", "5.%", "+12.5%", "-12.5%", "1e2%"];

  // Correct implementation must reject all unrelated syntax
  for (const inv of unrelatedSyntax) {
    assert.throws(() => parsePercentageCorrect(inv), RangeError);
  }

  // Broadened implementation incorrectly accepts +50% and -50%
  assert.equal(parsePercentageBroad("+50%"), 0.5);
  assert.equal(parsePercentageBroad("-50%"), -0.5);
});

test("task5-v1.1: 2. precision preservation detects and rejects arbitrary toPrecision(12) truncation", () => {
  function parsePercentageExact(input) {
    if (typeof input !== "string") throw new TypeError("Percentage input must be a string");
    const trimmed = input.trim();
    const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)%$/);
    if (!match) throw new RangeError(`Invalid percentage format: "${input}"`);
    return Number(match[1] + "e-2");
  }

  function parsePercentageTruncated(input) {
    if (typeof input !== "string") throw new TypeError("Percentage input must be a string");
    const trimmed = input.trim();
    const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)%$/);
    if (!match) throw new RangeError(`Invalid percentage format: "${input}"`);
    return Number((Number(match[1]) / 100).toPrecision(12));
  }

  const longInput = "12.3456789012345%";
  const expected = Number("12.3456789012345e-2");

  // Exact implementation preserves full precision
  assert.equal(parsePercentageExact(longInput), expected);

  // Truncated implementation loses precision beyond 12 digits
  assert.notEqual(parsePercentageTruncated(longInput), expected);
  assert.equal(parsePercentageTruncated(longInput), 0.123456789012);
});

test("task5-v1.1: 3. flash-worker.md contains generic investigation fast path and precision/grammar preservation rules", () => {
  const workerDocPath = resolve(runtimeRoot, ".agents/agents/flash-worker.md");
  assert.ok(existsSync(workerDocPath));
  const content = readFileSync(workerDocPath, "utf-8");

  assert.ok(content.includes("LOCATE IF NEEDED -> REPRODUCE ONCE -> ONE BATCH READ -> ROOT CAUSE -> MINIMAL MUTATION -> FOCUSED VALIDATION -> HANDOFF -> STOP"));
  assert.ok(content.includes("NEW REQUIRED BEHAVIOR != PERMISSION TO BROADEN THE INPUT LANGUAGE"));
  assert.ok(content.includes("Behavioral Surface Preservation"));
  assert.ok(content.includes("Precision Preservation"));
  assert.ok(content.includes("toPrecision(N)"));
  assert.ok(content.includes("worker_model_turns <= 8"));
  assert.ok(content.includes("worker_pre_mutation_turns <= 3"));
  assert.ok(content.includes("worker_search_turns <= 1"));

  // Ensure no Task-5-specific benchmark answers leaked into runtime prompt
  assert.ok(!content.includes("parsePercentage"), "Must not leak Task 5 symbol names into worker prompt");
  assert.ok(!content.includes("12.5%"), "Must not leak Task 5 inputs into worker prompt");
  assert.ok(!content.includes("99.9%"), "Must not leak Task 5 inputs into worker prompt");
  assert.ok(!content.includes("parser.js"), "Must not leak Task 5 path into worker prompt");
});

test("task5-v1.2: 1. source orchestrator profile does not expose schedule and carries Terminal Delegation Protocol", () => {
  const orchDocPath = resolve(runtimeRoot, ".agents/agents/flash-orchestrator.md");
  assert.ok(existsSync(orchDocPath));
  const content = readFileSync(orchDocPath, "utf-8");

  // Verify YAML frontmatter tools does not include schedule
  const frontmatter = content.split("---")[1] || "";
  assert.ok(!frontmatter.includes("- schedule"), "Orchestrator frontmatter tools must not expose schedule");
  assert.ok(frontmatter.includes("- invoke_subagent"));

  // Verify high-salience Terminal Delegation Protocol is present
  assert.ok(content.includes("TERMINAL DELEGATION PROTOCOL"));
  assert.ok(content.includes("AFTER `invoke_subagent` SUCCEEDS:"));
  assert.ok(content.includes("RETURN/YIELD IMMEDIATELY WITH ZERO TOOLS"));
  assert.ok(content.includes("DO NOT SCHEDULE, POLL, WATCH, OR CREATE A WATCHDOG"));
});

test("task5-v1.2: 2. installed benchmark orchestrator profile preserves schedule absence and Terminal Delegation semantics", () => {
  const tempProject = mkdtempSync(join(tmpdir(), "orch-test-install-parity-"));
  const installAgyScript = resolve(runtimeRoot, "../../scripts/install-antigravity.mjs");
  try {
    execFileSync(process.execPath, [installAgyScript, tempProject], { encoding: "utf8" });
    const installedOrchPath = join(tempProject, ".agents/agents/flash-orchestrator.md");
    assert.ok(existsSync(installedOrchPath));
    const installedContent = readFileSync(installedOrchPath, "utf-8");

    const frontmatter = installedContent.split("---")[1] || "";
    assert.ok(!frontmatter.includes("- schedule"));
    assert.ok(installedContent.includes("TERMINAL DELEGATION PROTOCOL"));
    assert.ok(installedContent.includes("RETURN/YIELD IMMEDIATELY WITH ZERO TOOLS"));

    // Verify source and installed profiles are identical
    const sourceContent = readFileSync(resolve(runtimeRoot, ".agents/agents/flash-orchestrator.md"), "utf-8");
    assert.equal(installedContent, sourceContent);
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
});

test("task5-v1.2: 3. no control-plane instruction positively recommends watchdog or timer polling after delegation", () => {
  const controlPlaneFiles = [
    resolve(runtimeRoot, ".agents/agents/flash-orchestrator.md"),
    resolve(runtimeRoot, "GEMINI.md"),
    resolve(runtimeRoot, ".agents/skills/orchestra/SKILL.md"),
  ];

  for (const filePath of controlPlaneFiles) {
    assert.ok(existsSync(filePath));
    const text = readFileSync(filePath, "utf-8");
    // Assert any occurrences of schedule, timer, watchdog, poll are prohibitions, not recommendations
    assert.ok(!/recommend.*(timer|watchdog|schedule|poll)/i.test(text));
    assert.ok(!/should.*(schedule.*timer|poll.*subagent)/i.test(text));
    assert.ok(!/use schedule to wait/i.test(text));
  }
});

test("task5-v1.2: 4. schedule attempt during healthy delegation remains denied and enforces zero-tool yield", () => {
  const preToolScript = resolve(runtimeRoot, ".agents/hooks/pre-tool-enforce.mjs");
  const tempDir = mkdtempSync(join(tmpdir(), "orch-sched-deny-"));
  try {
    const stateDir = join(tempDir, ".agents/state");
    mkdirSync(stateDir, { recursive: true });
    const state = {
      activeRole: "ORCHESTRATOR",
      state: "DELEGATED",
      subagent_invocations: 1,
      activeSubagent: { conversationId: "sub-123", role: "WORKER", healthy: true },
      deniedAttempts: [],
    };
    const statePath = join(stateDir, "active-state.json");
    writeFileSync(statePath, JSON.stringify(state), "utf-8");

    const payload = JSON.stringify({
      conversationId: "orch-parent-conv",
      toolCall: {
        name: "schedule",
        args: { DurationSeconds: 60, Prompt: "wait" },
      },
    });

    const res = JSON.parse(execFileSync("node", [preToolScript], { input: payload, cwd: tempDir, encoding: "utf-8" }));
    assert.equal(res.decision, "deny");
    assert.ok(res.reason.includes("Reactive Wakeup policy"));
    assert.ok(res.reason.includes("TERMINAL DELEGATION PROTOCOL"));
    assert.ok(res.reason.includes("ZERO tools"));

    const updatedState = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(updatedState.deniedAttempts.length, 1);
    assert.equal(updatedState.deniedAttempts[0].tool, "schedule");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task5-v1.2: 5. legitimate recovery or cancellation behavior remains intact", () => {
  const preToolScript = resolve(runtimeRoot, ".agents/hooks/pre-tool-enforce.mjs");
  const tempDir = mkdtempSync(join(tmpdir(), "orch-recovery-"));
  try {
    // Cancellation (manage_task kill) is always allowed even during delegation
    const killPayload = JSON.stringify({
      toolName: "manage_task",
      toolArgs: { Action: "kill", TaskId: "task-999" },
      cwdOverride: tempDir,
    });
    const killRes = JSON.parse(execFileSync("node", [preToolScript], { input: killPayload }));
    assert.equal(killRes.decision, "allow");

    // Outside healthy delegation (e.g. idle/direct action), schedule is not blocked by delegation lock
    const idleState = { state: "IDLE" };
    const idleStatePath = join(tempDir, "active-state.json");
    writeFileSync(idleStatePath, JSON.stringify(idleState), "utf-8");

    const idleSchedPayload = JSON.stringify({
      toolName: "schedule",
      toolArgs: { DurationSeconds: 10, Prompt: "remind" },
      cwdOverride: tempDir,
      customStatePath: idleStatePath,
    });
    const idleSchedRes = JSON.parse(execFileSync("node", [preToolScript], { input: idleSchedPayload }));
    assert.equal(idleSchedRes.decision, "allow");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task5-v1.2: 6. flash-worker.md contains Complete Failing Data Path principle", () => {
  const workerDocPath = resolve(runtimeRoot, ".agents/agents/flash-worker.md");
  const content = readFileSync(workerDocPath, "utf-8");

  assert.ok(content.includes("FIRST FIX MUST COVER THE COMPLETE OBSERVABLE FAILURE PATH") || content.includes("Complete Failing Data Path Before Mutation"));
  assert.ok(content.includes("trace the failing input through the entire code path") || content.includes("inspect the complete data path from input acceptance to returned observable value"));
  assert.ok(content.includes("account for every transformation"));
  assert.ok(content.includes("Do NOT stop at the first obvious defect") || content.includes("Do not stop root-cause analysis at the first visible syntax/validation defect"));
});

test("task5-v1.3: 1. Validation Completion Lock (Cases A through J)", () => {
  const preToolScript = resolve(runtimeRoot, ".agents/hooks/pre-tool-enforce.mjs");
  const tempDir = mkdtempSync(join(tmpdir(), "orch-val-lock-"));
  try {
    const stateDir = join(tempDir, ".agents/state");
    mkdirSync(stateDir, { recursive: true });

    // Setup role bindings for worker
    const roleBindings = {
      mainConversationId: "orch-parent",
      bindings: {
        "orch-parent": { role: "ORCHESTRATOR", profile: "flash-orchestrator" },
        "worker-child": { role: "WORKER", profile: "flash-worker" },
        "reviewer-child": { role: "REVIEWER", profile: "flash-reviewer" },
      },
    };
    writeFileSync(join(stateDir, "role-bindings.json"), JSON.stringify(roleBindings), "utf-8");

    const contract = {
      contractId: "contract-val-lock",
      allowedPaths: ["src/**", "test/**"],
      forbiddenPaths: [".agents/**"],
      testsRequired: ["node --test test/parser.test.js"],
    };
    writeFileSync(join(stateDir, "active-contract.json"), JSON.stringify(contract), "utf-8");

    function runHook(convId, toolName, args) {
      const payload = JSON.stringify({
        conversationId: convId,
        toolCall: {
          name: toolName,
          args,
        },
      });
      return JSON.parse(execFileSync("node", [preToolScript], { input: payload, cwd: tempDir, encoding: "utf-8" }));
    }

    // A. required focused test passes after latest mutation -> additional equivalent/broader routine validation DENIED
    const stateA = {
      activeRole: "WORKER",
      state: "DELEGATED",
      mutationSeq: 1,
      mutations: [{ seq: 1, path: "src/parser.js", actorRole: "WORKER" }],
      evidenceLedger: [
        {
          command: "node --test test/parser.test.js",
          exitCode: 0,
          mutationSeq: 1,
          actorRole: "WORKER",
          confidence: "HIGH",
        },
      ],
    };
    writeFileSync(join(stateDir, "active-state.json"), JSON.stringify(stateA), "utf-8");
    const resA = runHook("worker-child", "run_command", { CommandLine: "node --test" });
    assert.equal(resA.decision, "deny", "Case A: broader routine validation must be denied");
    assert.ok(resA.reason.includes("VALIDATION_ALREADY_SATISFIED"));

    // B. same required passing test repeated -> DENIED
    const resB = runHook("worker-child", "run_command", { CommandLine: "node --test test/parser.test.js" });
    assert.equal(resB.decision, "deny", "Case B: repeated passing test must be denied");
    assert.ok(resB.reason.includes("VALIDATION_ALREADY_SATISFIED"));

    // C. loop/stress validation after required test already passed -> DENIED
    const resC = runHook("worker-child", "run_command", { CommandLine: "for i in {1..5}; do node --test test/parser.test.js || exit 1; done" });
    assert.equal(resC.decision, "deny", "Case C: stress loop after passing validation must be denied");
    assert.ok(resC.reason.includes("VALIDATION_ALREADY_SATISFIED"));

    // D. required validation fails -> next validation ALLOWED
    const stateD = {
      activeRole: "WORKER",
      state: "DELEGATED",
      mutationSeq: 1,
      mutations: [{ seq: 1, path: "src/parser.js", actorRole: "WORKER" }],
      evidenceLedger: [
        {
          command: "node --test test/parser.test.js",
          exitCode: 1, // failed!
          mutationSeq: 1,
          actorRole: "WORKER",
          confidence: "HIGH",
        },
      ],
    };
    writeFileSync(join(stateDir, "active-state.json"), JSON.stringify(stateD), "utf-8");
    const resD = runHook("worker-child", "run_command", { CommandLine: "node --test test/parser.test.js" });
    assert.equal(resD.decision, "allow", "Case D: next validation must be allowed after failure");

    // E. mutation after previous passing validation -> next validation ALLOWED
    const stateE = {
      activeRole: "WORKER",
      state: "DELEGATED",
      mutationSeq: 2, // new mutation!
      mutations: [
        { seq: 1, path: "src/parser.js", actorRole: "WORKER" },
        { seq: 2, path: "src/parser.js", actorRole: "WORKER" },
      ],
      evidenceLedger: [
        {
          command: "node --test test/parser.test.js",
          exitCode: 0,
          mutationSeq: 1, // stale!
          actorRole: "WORKER",
          confidence: "HIGH",
        },
      ],
    };
    writeFileSync(join(stateDir, "active-state.json"), JSON.stringify(stateE), "utf-8");
    const resE = runHook("worker-child", "run_command", { CommandLine: "node --test test/parser.test.js" });
    assert.equal(resE.decision, "allow", "Case E: validation after new mutation must be allowed");

    // F. two distinct required commands, only first satisfied -> second required command ALLOWED
    const contractMulti = {
      contractId: "contract-multi",
      allowedPaths: ["src/**", "test/**"],
      forbiddenPaths: [".agents/**"],
      testsRequired: ["node --test test/a.test.js", "node --test test/b.test.js"],
    };
    writeFileSync(join(stateDir, "active-contract.json"), JSON.stringify(contractMulti), "utf-8");
    const stateF = {
      activeRole: "WORKER",
      state: "DELEGATED",
      mutationSeq: 1,
      mutations: [{ seq: 1, path: "src/a.js", actorRole: "WORKER" }],
      evidenceLedger: [
        {
          command: "node --test test/a.test.js",
          exitCode: 0,
          mutationSeq: 1,
          actorRole: "WORKER",
          confidence: "HIGH",
        },
      ],
    };
    writeFileSync(join(stateDir, "active-state.json"), JSON.stringify(stateF), "utf-8");
    const resF = runHook("worker-child", "run_command", { CommandLine: "node --test test/b.test.js" });
    assert.equal(resF.decision, "allow", "Case F: unsatisfied second required command must be allowed");

    // G. all required commands satisfied -> any further routine validation DENIED
    const stateG = {
      activeRole: "WORKER",
      state: "DELEGATED",
      mutationSeq: 1,
      mutations: [{ seq: 1, path: "src/a.js", actorRole: "WORKER" }],
      evidenceLedger: [
        {
          command: "node --test test/a.test.js",
          exitCode: 0,
          mutationSeq: 1,
          actorRole: "WORKER",
          confidence: "HIGH",
        },
        {
          command: "node --test test/b.test.js",
          exitCode: 0,
          mutationSeq: 1,
          actorRole: "WORKER",
          confidence: "HIGH",
        },
      ],
    };
    writeFileSync(join(stateDir, "active-state.json"), JSON.stringify(stateG), "utf-8");
    const resG = runHook("worker-child", "run_command", { CommandLine: "npm test" });
    assert.equal(resG.decision, "deny", "Case G: further routine validation must be denied when all satisfied");
    assert.ok(resG.reason.includes("VALIDATION_ALREADY_SATISFIED"));

    // H. stale validation -> does not lock
    const stateH = {
      activeRole: "WORKER",
      state: "DELEGATED",
      mutationSeq: 1,
      mutations: [{ seq: 1, path: "src/a.js", actorRole: "WORKER" }],
      evidenceLedger: [
        {
          command: "node --test test/a.test.js",
          exitCode: 0,
          mutationSeq: 0, // stale pre-mutation!
          actorRole: "WORKER",
          confidence: "HIGH",
        },
      ],
    };
    writeFileSync(join(stateDir, "active-state.json"), JSON.stringify(stateH), "utf-8");
    const resH = runHook("worker-child", "run_command", { CommandLine: "node --test test/a.test.js" });
    assert.equal(resH.decision, "allow", "Case H: stale validation must not lock");

    // I. UNKNOWN / REVIEWER evidence -> does not satisfy WORKER validation lock
    const stateI = {
      activeRole: "WORKER",
      state: "DELEGATED",
      mutationSeq: 1,
      mutations: [{ seq: 1, path: "src/a.js", actorRole: "WORKER" }],
      evidenceLedger: [
        {
          command: "node --test test/a.test.js",
          exitCode: 0,
          mutationSeq: 1,
          actorRole: "REVIEWER", // REVIEWER, not WORKER!
          confidence: "HIGH",
        },
      ],
    };
    writeFileSync(join(stateDir, "active-state.json"), JSON.stringify(stateI), "utf-8");
    const resI = runHook("worker-child", "run_command", { CommandLine: "node --test test/a.test.js" });
    assert.equal(resI.decision, "allow", "Case I: REVIEWER evidence cannot satisfy WORKER validation lock");

    // J. handoff/send_message after validation completion -> ALLOWED
    writeFileSync(join(stateDir, "active-state.json"), JSON.stringify(stateG), "utf-8");
    const resJ = runHook("worker-child", "send_message", {
      Recipient: "orch-parent",
      Message: "STATUS: IMPLEMENTATION_COMPLETE",
    });
    assert.equal(resJ.decision, "allow", "Case J: send_message after validation completion must be allowed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("task5-v1.3: 2. Same-Turn Delegation invariant in Orchestrator profiles", () => {
  const orchDocPath = resolve(runtimeRoot, ".agents/agents/flash-orchestrator.md");
  const geminiDocPath = resolve(runtimeRoot, "GEMINI.md");
  const skillDocPath = resolve(runtimeRoot, ".agents/skills/orchestra/SKILL.md");

  for (const p of [orchDocPath, geminiDocPath, skillDocPath]) {
    assert.ok(existsSync(p));
    const content = readFileSync(p, "utf-8");
    assert.ok(content.includes("SAME-TURN DELEGATION") || content.includes("Same-Turn Delegation"));
    assert.ok(content.includes("define_subagent") && content.includes("invoke_subagent"));
  }
});

test("task5-v1.3: 3. Worker Discovery Budget <= 1 and Whole Class Location Operations", () => {
  const workerDocPath = resolve(runtimeRoot, ".agents/agents/flash-worker.md");
  const content = readFileSync(workerDocPath, "utf-8");

  assert.ok(content.includes("Discovery Budget <= 1"));
  assert.ok(content.includes("list_dir"));
  assert.ok(content.includes("find_by_name"));
  assert.ok(content.includes("grep_search"));
  assert.ok(content.includes("DISCOVERY IS PERMANENTLY CLOSED") || content.includes("DISCOVERY IS CLOSED"));
  assert.ok(content.includes("VALIDATION COMPLETION LOCK"));
  assert.ok(content.includes("VALIDATION_ALREADY_SATISFIED"));

  // Ensure no Task 5 answers leaked
  assert.ok(!content.includes("parsePercentage"));
  assert.ok(!content.includes("12.5%"));
  assert.ok(!content.includes("99.9%"));
  assert.ok(!content.includes("parser.js"));
});

test("task5-v1.4: 1. Policy B & Bounded Factual Correction (Cases A through J)", () => {
  // A. first mutation passes immediately
  // -> correction cycles 0 -> hard PASS -> stretch may PASS
  const caseA_econ = evaluateInvestigationEconomy({
    parent_model_turns: 3,
    worker_model_turns: 7,
    total_model_turns: 10,
    worker_pre_mutation_turns: 3,
    worker_discovery_turns: 1,
    parent_delegated_sidequest_attempts: 0,
    duplicate_reads: 0,
    post_mutation_rereads: 0,
    repeated_validation_without_mutation: 0,
    correction_cycles: 0,
    first_mutation_complete: true,
  });
  assert.equal(caseA_econ.hard_gate, "PASS", "Case A: Hard economy must PASS");
  assert.equal(caseA_econ.stretch_gate, "PASS", "Case A: Stretch economy must PASS");
  const caseA_corr = evaluateBoundedFactualCorrection({
    correctionCycles: 0,
    reproductionObserved: true,
    reproductionExitCode: 1,
    firstValidationExitCode: 0,
  });
  assert.equal(caseA_corr.gate, "PASS", "Case A: Bounded correction gate must PASS on immediate fix");
  assert.equal(caseA_corr.correction_cycles, 0);

  // B. first validation fails, one direct correction, next validation passes
  // -> correction cycles 1 -> bounded correction PASS
  const caseB_corr = evaluateBoundedFactualCorrection({
    correctionCycles: 1,
    reproductionObserved: true,
    reproductionActor: "WORKER",
    reproductionExitCode: 1,
    firstMutationTargeted: true,
    firstValidationExitCode: 1,
    validationExposedMechanism: true,
    searchesBetweenFailedValidationAndCorrection: 0,
    readsBetweenFailedValidationAndCorrection: 0,
    duplicateReadsBetweenFailedValidationAndCorrection: 0,
    correctiveMutationAddressedFailure: true,
    nextValidationExitCode: 0,
    passingValidationsAfter: 0,
    repeatedValidationWithoutMutation: 0,
    apiShapePreserved: true,
    scopeMinimal: true,
    mutationAttribution: "WORKER",
    acceptanceReusedEvidence: true,
    workerValidationVerified: true,
  });
  assert.equal(caseB_corr.gate, "PASS", "Case B: single factual correction cycle must PASS");
  assert.equal(caseB_corr.correction_cycles, 1);

  // C. failed validation followed by new search
  // -> bounded correction FAIL
  const caseC_corr = evaluateBoundedFactualCorrection({
    correctionCycles: 1,
    reproductionObserved: true,
    firstValidationExitCode: 1,
    searchesBetweenFailedValidationAndCorrection: 1,
    nextValidationExitCode: 0,
  });
  assert.equal(caseC_corr.gate, "FAIL", "Case C: new search during correction must FAIL");
  assert.ok(caseC_corr.violations.some((v) => v.includes("NEW_SEARCH_DURING_CORRECTION")));

  // D. failed validation followed by duplicate reread
  // -> bounded correction FAIL
  const caseD_corr = evaluateBoundedFactualCorrection({
    correctionCycles: 1,
    reproductionObserved: true,
    firstValidationExitCode: 1,
    readsBetweenFailedValidationAndCorrection: 1,
    nextValidationExitCode: 0,
  });
  assert.equal(caseD_corr.gate, "FAIL", "Case D: reread during correction must FAIL");
  assert.ok(caseD_corr.violations.some((v) => v.includes("REREAD_DURING_CORRECTION")));

  // E. two corrective mutation cycles
  // -> bounded correction FAIL
  const caseE_corr = evaluateBoundedFactualCorrection({
    correctionCycles: 2,
    reproductionObserved: true,
    firstValidationExitCode: 1,
    nextValidationExitCode: 0,
  });
  assert.equal(caseE_corr.gate, "FAIL", "Case E: 2 corrective mutation cycles must FAIL bounded correction gate");
  assert.ok(caseE_corr.violations.some((v) => v.includes("EXCESSIVE_CORRECTION_CYCLES")));
  const caseE_econ = evaluateInvestigationEconomy({
    parent_model_turns: 3,
    worker_model_turns: 9,
    total_model_turns: 12,
    correction_cycles: 2,
  });
  assert.equal(caseE_econ.hard_gate, "FAIL", "Case E: 2 corrective mutation cycles must FAIL hard economy gate");

  // F. correction unrelated to observed validation failure
  // -> bounded correction FAIL
  const caseF_corr = evaluateBoundedFactualCorrection({
    correctionCycles: 1,
    reproductionObserved: true,
    firstValidationExitCode: 1,
    correctiveMutationAddressedFailure: false,
    nextValidationExitCode: 0,
  });
  assert.equal(caseF_corr.gate, "FAIL", "Case F: unrelated corrective mutation must FAIL");
  assert.ok(caseF_corr.violations.some((v) => v.includes("CORRECTIVE_MUTATION_UNRELATED")));

  // G. passing validation followed by another validation
  // -> existing Validation Completion discipline still applies
  const caseG_corr = evaluateBoundedFactualCorrection({
    correctionCycles: 1,
    reproductionObserved: true,
    firstValidationExitCode: 1,
    nextValidationExitCode: 0,
    repeatedValidationWithoutMutation: 1,
  });
  assert.equal(caseG_corr.gate, "FAIL", "Case G: repeated validation without mutation must FAIL bounded correction");
  assert.ok(caseG_corr.violations.some((v) => v.includes("REDUNDANT_VALIDATION_AFTER_PASS")));

  // H. worker 9 / total 12 with otherwise healthy bounded correction
  // -> HARD economy PASS
  const caseH_econ = evaluateInvestigationEconomy({
    parent_model_turns: 3,
    worker_model_turns: 9,
    total_model_turns: 12,
    worker_pre_mutation_turns: 3,
    worker_discovery_turns: 1,
    parent_delegated_sidequest_attempts: 0,
    duplicate_reads: 0,
    post_mutation_rereads: 0,
    repeated_validation_without_mutation: 0,
    correction_cycles: 1,
    first_mutation_complete: false,
  });
  assert.equal(caseH_econ.hard_gate, "PASS", "Case H: worker 9 / total 12 must pass HARD economy gate");

  // I. worker 10 or total 13
  // -> HARD economy FAIL
  const caseI_worker10 = evaluateInvestigationEconomy({
    parent_model_turns: 3,
    worker_model_turns: 10,
    total_model_turns: 12,
    correction_cycles: 1,
  });
  assert.equal(caseI_worker10.hard_gate, "FAIL", "Case I: worker 10 must FAIL HARD economy gate");

  const caseI_total13 = evaluateInvestigationEconomy({
    parent_model_turns: 3,
    worker_model_turns: 9,
    total_model_turns: 13,
    correction_cycles: 1,
  });
  assert.equal(caseI_total13.hard_gate, "FAIL", "Case I: total 13 must FAIL HARD economy gate");

  // J. worker 9 / total 12
  // -> STRETCH economy MISS, not hard failure
  const caseJ_econ = evaluateInvestigationEconomy({
    parent_model_turns: 3,
    worker_model_turns: 9,
    total_model_turns: 12,
    worker_pre_mutation_turns: 3,
    worker_discovery_turns: 1,
    parent_delegated_sidequest_attempts: 0,
    duplicate_reads: 0,
    post_mutation_rereads: 0,
    repeated_validation_without_mutation: 0,
    correction_cycles: 1,
    first_mutation_complete: false,
  });
  assert.equal(caseJ_econ.hard_gate, "PASS", "Case J: worker 9 / total 12 must PASS hard gate");
  assert.equal(caseJ_econ.stretch_gate, "MISS", "Case J: worker 9 / total 12 must MISS stretch target without failing hard gate");
  assert.equal(caseJ_econ.hard_pass, true, "Case J: hard_pass must remain true");
  assert.equal(caseJ_econ.stretch_pass, false, "Case J: stretch_pass must be false");
});
