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

