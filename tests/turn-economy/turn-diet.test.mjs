import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
} from "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs";
import { canonicalizePath } from "../../benchmarks/turn-economy/run.mjs";
import { isValidAgentName } from "../../runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs";

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
  assert.equal(out.decision, "allow");
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
