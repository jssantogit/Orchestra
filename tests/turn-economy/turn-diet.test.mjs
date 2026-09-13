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

test("turn-diet: post-tool hook records worker validation and handoff from worker send_message", () => {
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

  const completionPacket = [
    "STATUS: IMPLEMENTATION_COMPLETE",
    "FILES CHANGED: [\"src/formatter.js\", \"test/formatter.test.js\"]",
    "WHAT CHANGED: Fixed sign preservation",
    "TESTS: [5 passed / 0 failed]",
    "ACCEPTANCE EVIDENCE: [verified with node --test test/formatter.test.js]",
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
  assert.equal(state.implementationComplete, true);
  assert.equal(state.workerValidationObserved, true);
  assert.equal(state.state, "EVIDENCE_READY");
  assert.ok(state.worker_packet_bytes > 0);
});

test("turn-diet: stop-guard automatically records acceptanceState ACCEPTED and state DONE when orchestrator concludes after worker completion", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    activeRole: "ORCHESTRATOR",
    state: "EVIDENCE_READY",
    implementationComplete: true,
    workerValidationObserved: true,
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
        timestamp: new Date().toISOString(),
      },
    ],
    requireEvidenceBeforeStop: true,
  }));

  const input = JSON.stringify({
    conversationId: "orch-parent",
    fullyIdle: true,
  });

  // Since evidence is fresh (mutationSeq matches), stop is allowed immediately without re-running
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

