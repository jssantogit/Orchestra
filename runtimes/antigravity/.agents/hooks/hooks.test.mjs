import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { executeGitOperation } from "./git-operation.mjs";
import { factualSubagentMatchesPending } from "./child-identity.mjs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(__dirname, "../..");
process.chdir(runtimeRoot);

const preToolScript = resolve(".agents/hooks/pre-tool-enforce.mjs");
const postToolScript = resolve(".agents/hooks/post-tool-telemetry.mjs");
const preInvocationScript = resolve(".agents/hooks/pre-invocation-guard.mjs");
const stopScript = resolve(".agents/hooks/stop-guard.mjs");
const runnerScript = resolve(".agents/hooks/output-gate-runner.mjs");
const verifyBatchScript = resolve(".agents/hooks/verify-batch.mjs");
const gitOpScript = resolve(".agents/hooks/git-operation.mjs");

function cleanState() {
  try { unlinkSync(".agents/state/active-state.json"); } catch {}
  try { unlinkSync(".agents/state/active-contract.json"); } catch {}
  try { unlinkSync(".agents/state/role-bindings.json"); } catch {}
  try { rmSync(".agents/state/executions", { recursive: true, force: true }); } catch {}
  try { unlinkSync(".agents/telemetry/events.jsonl"); } catch {}
  try { rmSync("scratch", { recursive: true, force: true }); } catch {}
}

function seedFactualWorkerIdentity(conversationId = "factual-worker-test", options = {}) {
  mkdirSync(".agents/state", { recursive: true });
  const parentConversationId = options.parentConversationId || "orchestrator-test";
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: parentConversationId,
    bindings: {
      [parentConversationId]: {
        conversationId: parentConversationId,
        role: "ORCHESTRATOR",
        profile: "flash-orchestrator",
        confidence: "HIGH",
        source: "CONVERSATION_BOUND_IDENTITY",
      },
      [conversationId]: {
        conversationId,
        role: "WORKER",
        profile: options.profile || "flash-worker",
        parentConversationId,
        delegationKind: options.delegationKind || "WORK",
        originToolCallId: options.originToolCallId || "test-worker-origin",
        confidence: "HIGH",
        source: "RUNTIME_IDENTITY",
        factualIdentityAt: new Date().toISOString(),
        consumed: true,
      },
    },
    conversations: {},
    pendingSubagents: [],
  }, null, 2), "utf8");
  return conversationId;
}


function seedFactualOrchestratorIdentity(conversationId = "orchestrator-test") {
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
    mainConversationId: conversationId,
    bindings: {
      [conversationId]: {
        conversationId,
        role: "ORCHESTRATOR",
        profile: "flash-orchestrator",
        confidence: "HIGH",
        source: "CONVERSATION_BOUND_IDENTITY",
      },
    },
    conversations: {},
    pendingSubagents: [],
  }, null, 2), "utf8");
  return conversationId;
}

test.after(() => {
  cleanState();
});

test("pre-tool hook: orchestrator cannot directly mutate hook-owned governance state", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));
    const input = JSON.stringify({
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve(".agents/state/active-state.json") }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert.match(output.reason, /HOOK_OWNED_GOVERNANCE_STATE/);
  } finally {
    cleanState();
  }
});

test("pre-tool hook: blocks reviewer from editing any product files", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "REVIEWER" }));

    const input = JSON.stringify({
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: resolve("apps/web/src/App.tsx") }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("Reviewer is strictly read-only"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: blocks orchestrator from writing product code", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    const input = JSON.stringify({
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("packages/core/src/autoeq/loss.ts") }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("Orchestrator is forbidden from directly writing product code"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: enforces scope contract allowed and forbidden paths", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));
    const workerConv = seedFactualWorkerIdentity("scope-worker");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      taskDomain: "UI",
      allowedPaths: ["apps/web/**"],
      forbiddenPaths: ["packages/core/**"]
    }));

    // Allowed
    const allowedInput = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("apps/web/src/components/Plot.tsx") }
      }
    });
    assert.equal(JSON.parse(execFileSync("node", [preToolScript], { input: allowedInput })).decision, "allow");

    // Forbidden path
    const forbiddenInput = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: resolve("packages/core/src/dsp.ts") }
      }
    });
    const forbiddenRes = JSON.parse(execFileSync("node", [preToolScript], { input: forbiddenInput }));
    assert.equal(forbiddenRes.decision, "deny");
    assert(forbiddenRes.reason.includes("forbiddenPaths"));

    // Outside allowed path
    const outsideInput = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("docs/specs/test.md") }
      }
    });
    const outsideRes = JSON.parse(execFileSync("node", [preToolScript], { input: outsideInput }));
    assert.equal(outsideRes.decision, "deny");
    assert(outsideRes.reason.includes("outside allowedPaths"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: prevents workers from spawning subagents", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));

    const input = JSON.stringify({
      toolCall: {
        name: "invoke_subagent",
        args: {}
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("Workers and Reviewers cannot spawn or coordinate subagents"));
  } finally {
    cleanState();
  }
});

test("post-tool hook: records telemetry to events.jsonl", () => {
  const input = JSON.stringify({
    stepIdx: 42,
    conversationId: "test-conv-1",
    modelName: "gemini-3.8-flash-high"
  });
  const output = JSON.parse(execFileSync("node", [postToolScript], { input }));
  assert.deepEqual(output, {});
  assert(existsSync(".agents/telemetry/events.jsonl"));
});

test("pre-invocation guard: injects advisory message on overhead or bloat", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      coordinationOverheadDetected: true,
      contextBloatDetected: true
    }));

    const output = JSON.parse(execFileSync("node", [preInvocationScript], { input: "{}" }));
    assert(output.injectSteps.length >= 2);
  } finally {
    cleanState();
  }
});

test("stop guard: defaults to stopping cleanly when idle", () => {
  cleanState();
  const output = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
  assert.equal(output.decision, "stop");
});

test("stop guard: blocks stop when task completion is claimed without acceptance", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      claimCompleted: true,
      state: "EXECUTING",
      acceptanceState: "PENDING"
    }));

    const output = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
    assert.equal(output.decision, "continue");
    assert(output.reason.includes("STOP_BLOCKED"));
  } finally {
    cleanState();
  }
});

test("stop guard: blocks stop when required tests have no Evidence Ledger runs", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      requireEvidenceBeforeStop: true,
      state: "EXECUTING",
      testsRequired: ["pnpm test"],
      evidenceLedger: []
    }));

    const output = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
    assert.equal(output.decision, "continue");
    assert(output.reason.includes("EVIDENCE_MISSING"));
    assert(output.reason.includes("- pnpm test"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: blocks Orchestrator from redirecting shell output to product code", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    const input = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "echo 'export const foo = 1;' > apps/web/x.ts" }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("Orchestrator is forbidden"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: blocks Orchestrator from running sed -i on product code", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    const input = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "sed -i 's/foo/bar/g' packages/core/src/index.ts" }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("Orchestrator is forbidden"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: allows Orchestrator to run read-only git diff", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    const input = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "git diff packages/core" }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "allow");
  } finally {
    cleanState();
  }
});

test("pre-tool hook: allows Orchestrator to run validation and test commands", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    const input = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "node --test .agents/hooks/hooks.test.mjs" }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "allow");
  } finally {
    cleanState();
  }
});

test("pre-tool hook: blocks Reviewer from executing any shell command", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "REVIEWER" }));

    const input = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "git status" }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("Reviewer is strictly read-only and is prohibited from executing shell commands"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: allows Flash worker to use shell write inside allowedPaths", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));
    const workerConv = seedFactualWorkerIdentity("shell-worker-in");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["packages/core/src/**"],
      forbiddenPaths: ["apps/**"]
    }));

    const input = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "run_command",
        args: { CommandLine: "echo 'export const x = 1;' > packages/core/src/calc.ts" }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "allow");
  } finally {
    cleanState();
  }
});

test("pre-tool hook: blocks Flash worker from using shell write outside allowedPaths", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));
    const workerConv = seedFactualWorkerIdentity("shell-worker-out");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["packages/core/src/**"],
      forbiddenPaths: []
    }));

    const input = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "run_command",
        args: { CommandLine: "echo 'export const x = 1;' > apps/web/src/calc.ts" }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("outside allowedPaths"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: blocks Flash worker from shell file removal in forbiddenPaths", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));
    const workerConv = seedFactualWorkerIdentity("shell-worker-forbidden");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["packages/core/**"],
      forbiddenPaths: ["packages/core/src/dsp.ts"]
    }));

    const input = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "run_command",
        args: { CommandLine: "rm packages/core/src/dsp.ts" }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("forbidden path"));
  } finally {
    cleanState();
  }
});

test("post-tool hook: records Gemini model observability fields", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "FLASH" }));

    const inputObservable = JSON.stringify({
      stepIdx: 100,
      conversationId: "test-obs-1",
      modelName: "gemini-3.8-flash-high",
      toolName: "replace_file_content"
    });
    execFileSync("node", [postToolScript], { input: inputObservable });

    const inputUnobservable = JSON.stringify({
      stepIdx: 101,
      conversationId: "test-obs-2",
      modelName: "auto",
      toolName: "run_command"
    });
    execFileSync("node", [postToolScript], { input: inputUnobservable });

    const events = readFileSync(".agents/telemetry/events.jsonl", "utf-8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));

    const obsEvent = events.find(e => e.conversationId === "test-obs-1");
    assert.equal(obsEvent.requested_agent, "flash-worker");
    assert.equal(obsEvent.requested_tier, "flash");
    assert.equal(obsEvent.configured_model, "gemini-3.8-flash-high");
    assert.equal(obsEvent.actual_runtime_model, "gemini-3.8-flash-high");
    assert.equal(obsEvent.runtime_model_observable, true);

    const unobsEvent = events.find(e => e.conversationId === "test-obs-2");
    assert.equal(unobsEvent.requested_agent, "flash-worker");
    assert.equal(unobsEvent.requested_tier, "flash");
    assert.equal(unobsEvent.configured_model, "gemini-3.8-flash-high");
    assert.equal(unobsEvent.actual_runtime_model, null);
    assert.equal(unobsEvent.runtime_model_observable, false);
  } finally {
    cleanState();
  }
});

test("pre-tool hook: allows legitimate JS arrow functions and comparisons without false redirection denial", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));
    const workerConv = seedFactualWorkerIdentity("parser-worker");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["src/**"],
      forbiddenPaths: [".agents/**"],
      testsRequired: [],
    }));

    // Arrow function
    const arrowInput = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "run_command",
        args: { CommandLine: 'node --test --test-name-pattern="a => b"' }
      }
    });
    const arrowRes = JSON.parse(execFileSync("node", [preToolScript], { input: arrowInput }));
    assert.equal(arrowRes.decision, "allow");

    // Relational comparisons
    const compInput = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "run_command",
        args: { CommandLine: 'node --test --test-name-pattern="elapsed >= 5 && elapsed <= 20"' }
      }
    });
    const compRes = JSON.parse(execFileSync("node", [preToolScript], { input: compInput }));
    assert.equal(compRes.decision, "allow");

    // Markdown blockquote
    const mdInput = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: 'echo "> *Why this change was made*"' }
      }
    });
    const mdRes = JSON.parse(execFileSync("node", [preToolScript], { input: mdInput }));
    assert.equal(mdRes.decision, "allow");
  } finally {
    cleanState();
  }
});

test("pre-tool hook: blocks real shell redirection to product code", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    const input = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "echo 'export const x = 1;' > packages/core/src/leak.ts" }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("Orchestrator is forbidden"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: anti-obfuscation blocks base64 decoding write to product code", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));
    const workerConv = seedFactualWorkerIdentity("shell-worker-obfuscation");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["scratch/**"],
      forbiddenPaths: ["packages/**"]
    }));

    const input = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "run_command",
        args: { CommandLine: "echo 'dmFyIHggPSAx' | base64 -d > packages/core/src/index.ts" }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("Scope contract violation"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: large file guard blocks dumping large files into context", () => {
  cleanState();
  const testLargeFile = resolve("scratch/test-large.json");
  try {
    mkdirSync("scratch", { recursive: true });
    writeFileSync(testLargeFile, "x".repeat(250000), "utf-8"); // 250 KB

    // cat large file -> blocked
    const catInput = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "cat scratch/test-large.json" }
      }
    });
    const catRes = JSON.parse(execFileSync("node", [preToolScript], { input: catInput }));
    assert.equal(catRes.decision, "deny");
    assert(catRes.reason.includes("LARGE_FILE_GUARD"));

    // jq '.' large file -> blocked
    const jqInput = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "jq '.' scratch/test-large.json" }
      }
    });
    const jqRes = JSON.parse(execFileSync("node", [preToolScript], { input: jqInput }));
    assert.equal(jqRes.decision, "deny");
    assert(jqRes.reason.includes("LARGE_FILE_GUARD"));

    // head large file -> allowed (filtered inspection)
    const headInput = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "head -n 20 scratch/test-large.json" }
      }
    });
    const headRes = JSON.parse(execFileSync("node", [preToolScript], { input: headInput }));
    assert.equal(headRes.decision, "allow");
  } finally {
    try { unlinkSync(testLargeFile); } catch {}
    cleanState();
  }
});

test("pre-tool hook: enforces polling budget and backoff on manage_task status", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));

    // 1st poll -> allowed
    const poll1 = JSON.stringify({
      toolCall: {
        name: "manage_task",
        args: { Action: "status", TaskId: "task-100" }
      }
    });
    const res1 = JSON.parse(execFileSync("node", [preToolScript], { input: poll1 }));
    assert.equal(res1.decision, "allow");

    // Immediate 2nd poll (< 15s) -> denied with POLLING_TOO_FAST
    const res2 = JSON.parse(execFileSync("node", [preToolScript], { input: poll1 }));
    assert.equal(res2.decision, "deny");
    assert(res2.reason.includes("POLLING_OVERHEAD") || res2.reason.includes("Polling status too quickly"));

    // Over budget (> 3 polls)
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "WORKER",
      pollingTracker: {
        taskId: "task-100",
        pollCount: 3,
        lastPollTimestamp: Date.now() - 30000 // 30s ago (valid backoff, but budget exhausted)
      }
    }));
    const res3 = JSON.parse(execFileSync("node", [preToolScript], { input: poll1 }));
    assert.equal(res3.decision, "deny");
    assert(res3.reason.includes("exceeded polling budget"));
  } finally {
    cleanState();
  }
});

test("output gate runner: preserves small stdout inline and truncates large output to artifact", () => {
  cleanState();
  const runnerScript = resolve(".agents/hooks/output-gate-runner.mjs");

  // Small output
  const smallOutput = execFileSync("node", [runnerScript, "--cmd", "echo 'inline small test'"], { encoding: "utf-8" });
  assert(smallOutput.includes("inline small test"));

  // Large output
  const largeOutput = execFileSync(
    "node",
    [runnerScript, "--cmd", 'node -e "for(let i=0; i<400; i++) console.log(\'line \' + i)"'],
    { encoding: "utf-8" }
  );
  assert(largeOutput.includes("[OUTPUT_TRUNCATED]"));
  assert(largeOutput.includes("raw_artifact:"));
  assert(largeOutput.includes("preview (first 30 lines):"));

  // Verify artifact exists on disk
  const artMatch = largeOutput.match(/raw_artifact:\s*([^\s]+)/);
  assert(artMatch && artMatch[1]);
  assert(existsSync(artMatch[1]));
  try { unlinkSync(artMatch[1]); } catch {}
});

test("post-tool hook: automatically records TYPECHECK and TEST_RUN in active-state Evidence Ledger via unique executionId", () => {
  cleanState();
  try {
    mkdirSync(".agents/state/executions/pending", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));

    // 1. Simulate execution of pnpm typecheck with unique executionId
    const execId1 = "exec-tc-123";
    writeFileSync(".agents/state/executions/pending/default__1.json", JSON.stringify({
      executionId: execId1,
      conversationId: "default",
      stepIdx: 1,
    }));
    writeFileSync(`.agents/state/executions/${execId1}.json`, JSON.stringify({
      executionId: execId1,
      command: "pnpm typecheck",
      exitCode: 0,
      durationMs: 500,
      stdoutBytes: 100,
      stderrBytes: 0,
      totalBytes: 100,
      totalLines: 5,
      truncated: false,
      artifactPath: null,
      preview: "typecheck complete",
      timestamp: new Date().toISOString(),
      consumed: false,
    }));

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({ toolName: "run_command", stepIdx: 1, conversationId: "default" })
    });

    let state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert(Array.isArray(state.evidenceLedger));
    const tcEntry = state.evidenceLedger.find(e => e.type === "TYPECHECK");
    assert(tcEntry);
    assert.equal(tcEntry.exitCode, 0);
    assert.equal(tcEntry.command, "pnpm typecheck");
    assert.equal(tcEntry.executionId, execId1);

    // 2. Simulate execution of pnpm test with unique executionId
    const execId2 = "exec-test-456";
    writeFileSync(".agents/state/executions/pending/default__2.json", JSON.stringify({
      executionId: execId2,
      conversationId: "default",
      stepIdx: 2,
    }));
    writeFileSync(`.agents/state/executions/${execId2}.json`, JSON.stringify({
      executionId: execId2,
      command: "pnpm test",
      exitCode: 0,
      durationMs: 1200,
      stdoutBytes: 300,
      stderrBytes: 0,
      totalBytes: 300,
      totalLines: 15,
      truncated: false,
      artifactPath: null,
      preview: "35 passed / 0 failed",
      timestamp: new Date().toISOString(),
      consumed: false,
    }));

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({ toolName: "run_command", stepIdx: 2, conversationId: "default" })
    });

    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    const testEntry = state.evidenceLedger.find(e => e.type === "TEST_RUN");
    assert(testEntry);
    assert.equal(testEntry.exitCode, 0);
    assert.equal(testEntry.passed, 35);
    assert.equal(testEntry.failed, 0);
    assert.equal(testEntry.executionId, execId2);
  } finally {
    cleanState();
  }
});

test("stop guard: automatically recorded evidence satisfies guard without model editing state", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      requireEvidenceBeforeStop: true,
      state: "EXECUTING",
      testsRequired: ["pnpm test"],
      evidenceLedger: [
        {
          id: "ev-1",
          type: "TEST_RUN",
          command: "pnpm test",
          exitCode: 0,
          passed: 10,
          failed: 0,
          timestamp: new Date().toISOString()
        }
      ]
    }));

    const output = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
    assert.equal(output.decision, "stop");
  } finally {
    cleanState();
  }
});

test("stop guard: trips STOP_GUARD_STALLED to HUMAN_GATE on repeated identical missing evidence", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      requireEvidenceBeforeStop: true,
      state: "EXECUTING",
      testsRequired: ["pnpm test"],
      evidenceLedger: []
    }));

    // First attempt -> EVIDENCE_MISSING
    const output1 = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
    assert.equal(output1.decision, "continue");
    assert(output1.reason.includes("EVIDENCE_MISSING"));

    // Second attempt without state/evidence changes -> STOP_GUARD_STALLED to HUMAN_GATE
    const output2 = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
    assert.equal(output2.decision, "continue");
    assert(output2.reason.includes("STOP_GUARD_STALLED"));

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.state, "HUMAN_GATE");
    assert.equal(state.circuitBreakerType, "STOP_GUARD_STALLED");
  } finally {
    cleanState();
  }
});

test("stop guard: allows stop when fullyIdle is false for reactive wakeup wait", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      requireEvidenceBeforeStop: true,
      state: "EXECUTING",
      testsRequired: ["pnpm test"],
      evidenceLedger: []
    }));

    const output = JSON.parse(execFileSync("node", [stopScript], { input: JSON.stringify({ fullyIdle: false }) }));
    assert.equal(output.decision, "stop");
  } finally {
    cleanState();
  }
});

test("concurrency: concurrent executions and out-of-order callbacks correctly populate evidence ledger", () => {
  cleanState();
  try {
    mkdirSync(".agents/state/executions/pending", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));

    const execA = "exec-worker-A-101";
    const execB = "exec-worker-B-102";

    // Worker A starts at step 10
    writeFileSync(".agents/state/executions/pending/default__10.json", JSON.stringify({
      executionId: execA,
      conversationId: "default",
      stepIdx: 10,
    }));

    // Worker B starts at step 11
    writeFileSync(".agents/state/executions/pending/default__11.json", JSON.stringify({
      executionId: execB,
      conversationId: "default",
      stepIdx: 11,
    }));

    // Worker B finishes first
    writeFileSync(`.agents/state/executions/${execB}.json`, JSON.stringify({
      executionId: execB,
      command: "pnpm --filter @autoeq-workbench/app test",
      exitCode: 0,
      durationMs: 800,
      stdoutBytes: 150,
      stderrBytes: 0,
      totalBytes: 150,
      totalLines: 10,
      truncated: false,
      artifactPath: null,
      preview: "20 passed / 0 failed",
      timestamp: new Date().toISOString(),
      consumed: false,
    }));

    // Worker A finishes second
    writeFileSync(`.agents/state/executions/${execA}.json`, JSON.stringify({
      executionId: execA,
      command: "pnpm --filter @autoeq-workbench/core test",
      exitCode: 0,
      durationMs: 1200,
      stdoutBytes: 250,
      stderrBytes: 0,
      totalBytes: 250,
      totalLines: 15,
      truncated: false,
      artifactPath: null,
      preview: "15 passed / 0 failed",
      timestamp: new Date().toISOString(),
      consumed: false,
    }));

    // PostToolUse callbacks arrive out of order: B first, then A
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({ toolName: "run_command", stepIdx: 11, conversationId: "default" })
    });
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({ toolName: "run_command", stepIdx: 10, conversationId: "default" })
    });

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.evidenceLedger.length, 2);

    const entryB = state.evidenceLedger.find(e => e.executionId === execB);
    const entryA = state.evidenceLedger.find(e => e.executionId === execA);

    assert(entryB);
    assert.equal(entryB.scope, "@autoeq-workbench/app");
    assert.equal(entryB.passed, 20);

    assert(entryA);
    assert.equal(entryA.scope, "@autoeq-workbench/core");
    assert.equal(entryA.passed, 15);

    assert.equal(state.totalToolOutputBytes, 400);
  } finally {
    cleanState();
  }
});

test("idempotency: duplicate PostToolUse callbacks do not duplicate evidence or byte counts", () => {
  cleanState();
  try {
    mkdirSync(".agents/state/executions/pending", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));

    const execId = "exec-idempotent-test";
    writeFileSync(".agents/state/executions/pending/default__5.json", JSON.stringify({
      executionId: execId,
      conversationId: "default",
      stepIdx: 5,
    }));
    writeFileSync(`.agents/state/executions/${execId}.json`, JSON.stringify({
      executionId: execId,
      command: "pnpm test",
      exitCode: 0,
      durationMs: 900,
      stdoutBytes: 200,
      stderrBytes: 0,
      totalBytes: 200,
      totalLines: 10,
      truncated: false,
      artifactPath: null,
      preview: "10 passed / 0 failed",
      timestamp: new Date().toISOString(),
      consumed: false,
    }));

    // First call
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({ toolName: "run_command", stepIdx: 5, conversationId: "default" })
    });

    let state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.evidenceLedger.length, 1);
    assert.equal(state.totalToolOutputBytes, 200);

    // Duplicate call for same execution
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({ toolName: "run_command", executionId: execId, conversationId: "default" })
    });

    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.evidenceLedger.length, 1);
    assert.equal(state.totalToolOutputBytes, 200);
  } finally {
    cleanState();
  }
});

test("uncorrelated: unknown executionId or stepIdx gracefully ignored without corruption", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER", evidenceLedger: [] }));

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({ toolName: "run_command", executionId: "nonexistent-exec-id", conversationId: "default" })
    });

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.evidenceLedger.length, 0);
  } finally {
    cleanState();
  }
});

test("evidence scope: stop guard blocks stop when evidence is from mismatched package scope", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      requireEvidenceBeforeStop: true,
      state: "EXECUTING",
      testsRequired: ["pnpm --filter @autoeq-workbench/app test"],
      evidenceLedger: [
        {
          id: "ev-core",
          executionId: "exec-core",
          type: "TEST_RUN",
          scope: "@autoeq-workbench/core",
          command: "pnpm --filter @autoeq-workbench/core test",
          exitCode: 0,
          passed: 10,
          failed: 0,
          timestamp: new Date().toISOString()
        }
      ]
    }));

    const output = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
    assert.equal(output.decision, "continue");
    assert(output.reason.includes("EVIDENCE_MISSING"));
    assert(output.reason.includes("@autoeq-workbench/app"));
  } finally {
    cleanState();
  }
});

test("runner semantic transparency matrix: verifies shell execution equivalence", () => {
  cleanState();

  // 1. CWD
  const defaultBash = process.platform === "win32" && existsSync("C:\\Program Files\\Git\\bin\\bash.exe") ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const cwdDirect = execFileSync(defaultBash, ["-c", "pwd"], { encoding: "utf-8" }).trim();
  const cwdRunner = execFileSync("node", [runnerScript, "--cmd", "pwd"], { encoding: "utf-8" }).trim();
  assert.equal(cwdRunner, cwdDirect);

  // 2. Environment variables
  const envRunner = execFileSync(
    "node",
    [runnerScript, "--cmd", "FOO=hardening_bar node -e 'console.log(process.env.FOO)'"],
    { encoding: "utf-8" }
  ).trim();
  assert.equal(envRunner, "hardening_bar");

  // 3. Pipelines
  const pipeRunner = execFileSync(
    "node",
    [runnerScript, "--cmd", 'printf "line1\\nline2\\nline3\\n" | grep line2'],
    { encoding: "utf-8" }
  ).trim();
  assert.equal(pipeRunner, "line2");

  // 4. Boolean shell operators (&& and ||)
  const andRunner = execFileSync("node", [runnerScript, "--cmd", "true && echo ok"], { encoding: "utf-8" }).trim();
  assert.equal(andRunner, "ok");

  const orRunner = execFileSync("node", [runnerScript, "--cmd", "false || echo fallback"], { encoding: "utf-8" }).trim();
  assert.equal(orRunner, "fallback");

  // 5. Exit codes
  assert.doesNotThrow(() => {
    execFileSync("node", [runnerScript, "--cmd", "node -e 'process.exit(0)'"]);
  });

  try {
    execFileSync("node", [runnerScript, "--cmd", "node -e 'process.exit(42)'"]);
    assert.fail("Should have thrown non-zero exit code");
  } catch (err) {
    assert.equal(err.status, 42);
  }

  // 6. Combined stdout and stderr
  const combinedOutput = execFileSync(
    "node",
    [runnerScript, "--cmd", 'node -e \'console.log("hello stdout"); console.error("hello stderr");\''],
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
  );
  assert(combinedOutput.includes("hello stdout"));

  // 7. Redirections allowed
  mkdirSync("scratch", { recursive: true });
  const redirFile = "scratch/test-runner-redir.txt";
  try {
    execFileSync("node", [runnerScript, "--cmd", `echo 'redir_test' > "${redirFile}" && cat "${redirFile}"`]);
    const readBack = readFileSync(redirFile, "utf-8").trim();
    assert.equal(readBack, "redir_test");
  } finally {
    try { unlinkSync(redirFile); } catch {}
  }

  // 8. Quoted arguments and spaces
  const quotedRunner = execFileSync(
    "node",
    [runnerScript, "--cmd", 'echo "spaced argument test"'],
    { encoding: "utf-8" }
  ).trim();
  assert.equal(quotedRunner, "spaced argument test");

  // 9. Background-compatible command
  const bgRunner = execFileSync(
    "node",
    [runnerScript, "--cmd", "sleep 0.05 && echo awake"],
    { encoding: "utf-8" }
  ).trim();
  assert.equal(bgRunner, "awake");

  // 10. Internal error on missing arguments
  try {
    execFileSync("node", [runnerScript, "--b64", ""], { stdio: ["pipe", "pipe", "pipe"] });
    assert.fail("Should have exited non-zero");
  } catch (err) {
    assert.equal(err.status, 1);
    const stderr = err.stderr ? err.stderr.toString("utf-8") : "";
    assert(stderr.includes("OUTPUT_GATE_INTERNAL_ERROR"));
  }
});

test("v3: post-tool hook updates tool mix, records mutations, and detects shell overuse", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));

    // 1. Native view_file
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "view_file",
        toolCall: { name: "view_file", args: { AbsolutePath: "/path/to/file.ts" } },
      }),
    });

    let state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.toolMix.native_read_calls, 1);

    // 2. Native write_to_file
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "write_to_file",
        toolCall: { name: "write_to_file", args: { TargetFile: "packages/core/src/index.ts" } },
      }),
    });

    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.toolMix.native_edit_calls, 1);
    assert.equal(state.mutationSeq, 1);
    assert.equal(state.mutations.length, 1);

    // 3. Avoidable run_command (cat)
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "run_command",
        toolCall: { name: "run_command", args: { CommandLine: "cat packages/core/src/index.ts" } },
      }),
    });

    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.toolMix.shell_read_calls, 1);
    assert.equal(state.toolMix.avoidable_shell_calls, 1);

    // 4. Non-avoidable run_command (test)
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "run_command",
        toolCall: { name: "run_command", args: { CommandLine: "pnpm test" } },
      }),
    });

    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.toolMix.shell_test_calls, 1);
    assert.equal(state.toolMix.avoidable_shell_calls, 1); // Not incremented by test
  } finally {
    cleanState();
  }
});

test("v3: pre-invocation guard injects NATIVE_TOOLS_FIRST advisory once upon shell overuse", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      shellOveruseDetected: true,
      shellOveruseAdvised: false,
    }));

    // First invocation: should inject advisory and mark advised
    const output1 = JSON.parse(execFileSync("node", [preInvocationScript], { input: "{}" }));
    const match = output1.injectSteps.some((s) => s.ephemeralMessage.includes("NATIVE_TOOLS_FIRST"));
    assert.equal(match, true);

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.shellOveruseAdvised, true);

    // Second invocation: should NOT inject advisory again
    const output2 = JSON.parse(execFileSync("node", [preInvocationScript], { input: "{}" }));
    const match2 = output2.injectSteps.some((s) => s.ephemeralMessage.includes("NATIVE_TOOLS_FIRST"));
    assert.equal(match2, false);
  } finally {
    cleanState();
  }
});

test("v3: stop guard blocks stop when required test evidence is STALE due to subsequent mutations", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    // Core test PASS at mutationSeq 1, but later mutation occurred at mutationSeq 2 in core
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      requireEvidenceBeforeStop: true,
      testsRequired: ["pnpm --filter @autoeq-workbench/core test"],
      mutationSeq: 2,
      mutations: [
        { mutationSeq: 2, paths: ["packages/core/src/dsp.ts"] },
      ],
      evidenceLedger: [
        {
          type: "TEST_RUN",
          scope: "@autoeq-workbench/core",
          command: "pnpm --filter @autoeq-workbench/core test",
          exitCode: 0,
          mutationSeq: 1,
        },
      ],
    }));

    // Should block stop because evidence is STALE
    const blockedRes = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
    assert.equal(blockedRes.decision, "continue");
    assert(blockedRes.reason.includes("EVIDENCE_MISSING"));

    // Now update evidence with fresh execution at mutationSeq 2
    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    state.evidenceLedger[0].mutationSeq = 2;
    writeFileSync(".agents/state/active-state.json", JSON.stringify(state, null, 2));

    // Should allow stop cleanly
    const allowedRes = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
    assert.equal(allowedRes.decision, "stop");
  } finally {
    cleanState();
  }
});

test("v4: verify-batch executes sequenced verification and records evidence in ledger", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      mutationSeq: 5,
      evidenceLedger: [],
    }));

    const steps = [
      { id: "step-1", command: "node -e 'process.exit(0)'", scope: "@autoeq-workbench/core" },
      { id: "step-2", command: "node -e 'process.exit(0)'", scope: "GLOBAL", dependsOn: "step-1" },
    ];

    const output = execFileSync("node", [verifyBatchScript, "--steps", JSON.stringify(steps), "--json"], { encoding: "utf-8" });
    const parsed = JSON.parse(output);

    assert.equal(parsed.success, true);
    assert.equal(parsed.summary.passed, 2);
    assert.equal(parsed.summary.failed, 0);
    assert.equal(parsed.summary.skipped, 0);

    const savedState = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(savedState.evidenceLedger.length, 2);
    assert.equal(savedState.toolMix.verification_batches, 1);
    assert.equal(savedState.toolMix.verification_batch_steps, 2);
  } finally {
    cleanState();
  }
});

test("v4: verify-batch skips dependent step if prerequisite fails", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      mutationSeq: 1,
      evidenceLedger: [],
    }));

    const steps = [
      { id: "step-fail", command: "node -e 'process.exit(1)'", scope: "@autoeq-workbench/core" },
      { id: "step-skip", command: "node -e 'process.exit(0)'", scope: "GLOBAL", dependsOn: "step-fail" },
    ];

    let output = "";
    try {
      output = execFileSync("node", [verifyBatchScript, "--steps", JSON.stringify(steps), "--json"], { encoding: "utf-8" });
    } catch (err) {
      output = err.stdout;
    }
    const parsed = JSON.parse(output);
    assert.equal(parsed.success, false);
    assert.equal(parsed.summary.passed, 0);
    assert.equal(parsed.summary.failed, 1);
    assert.equal(parsed.summary.skipped, 1);

    const skippedStep = parsed.results.find((r) => r.id === "step-skip");
    assert.equal(skippedStep.status, "SKIPPED_PREREQUISITE_FAILED");
  } finally {
    cleanState();
  }
});

test("v4: post-tool telemetry tracks targeted views, git inspections, and shell mutations", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      mutationSeq: 1,
    }));

    // 1. Targeted view_file
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "view_file",
        toolCall: {
          name: "view_file",
          args: { AbsolutePath: resolve("README.md"), StartLine: 10, EndLine: 50 },
        },
      }),
    });

    let state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.toolMix.targeted_view_calls, 1);
    assert.equal(state.toolMix.view_file_lines, 41);

    // 2. Git inspection
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "run_command",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "git status --short" },
        },
      }),
    });

    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.toolMix.git_inspection_calls, 1);
    assert.equal(state.toolMix.redundant_git_inspections, 0);

    // 3. Redundant Git inspection (no mutations)
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "run_command",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "git status --short" },
        },
      }),
    });

    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.toolMix.git_inspection_calls, 2);
    assert.equal(state.toolMix.redundant_git_inspections, 1);

    // 4. Shell mutation
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "run_command",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "touch packages/core/src/new-file.ts" },
        },
      }),
    });

    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.toolMix.shell_mutations, 1);
    assert.equal(state.mutationSeq, 2);
  } finally {
    cleanState();
  }
});

test("v4: pre-invocation guard delivers pending advisories and consumes them on subsequent turn", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      advisories: [
        { id: "adv-test", type: "INFO", message: "Use targeted window for reading", status: "PENDING" },
      ],
    }));

    // Turn 1: delivers pending advisory
    const turn1 = JSON.parse(execFileSync("node", [preInvocationScript], { input: "{}" }));
    const delivered = turn1.injectSteps.some((s) => s.ephemeralMessage.includes("Use targeted window"));
    assert.equal(delivered, true);

    let state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.advisories[0].status, "DELIVERED");

    // Turn 2: consumes delivered advisory and does not inject it again
    const turn2 = JSON.parse(execFileSync("node", [preInvocationScript], { input: "{}" }));
    const reDelivered = turn2.injectSteps.some((s) => s.ephemeralMessage.includes("Use targeted window"));
    assert.equal(reDelivered, false);

    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.advisories.length, 0);
  } finally {
    cleanState();
  }
});

test("v5: pre-tool hook blocks subagent spawning during DIRECT_ACTION", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(
      ".agents/state/active-state.json",
      JSON.stringify({ activeRole: "ORCHESTRATOR", taskAction: "DIRECT_ACTION" })
    );

    const input = JSON.stringify({
      toolCall: {
        name: "invoke_subagent",
        args: { Subagents: [{ TypeName: "flash-worker", Prompt: "do work", Role: "Worker" }] }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("DIRECT_ACTION_SUBAGENT_PROHIBITED"));

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.toolMix.direct_action_side_quests_prevented, 1);
  } finally {
    cleanState();
  }
});

test("v5: pre-tool hook blocks file edits outside control plane during DIRECT_ACTION (side-quest prevention)", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(
      ".agents/state/active-state.json",
      JSON.stringify({ activeRole: "ORCHESTRATOR", taskAction: "DIRECT_ACTION" })
    );

    const input = JSON.stringify({
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: resolve("packages/core/src/index.ts") }
      }
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("DIRECT_ACTION_SIDE_QUEST"));

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.toolMix.direct_action_side_quests_prevented, 1);
  } finally {
    cleanState();
  }
});

test("v5: stop guard allows clean stop for DIRECT_ACTION without implementation acceptance", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(
      ".agents/state/active-state.json",
      JSON.stringify({
        taskAction: "DIRECT_ACTION",
        state: "DONE",
        claimCompleted: true,
        testsRequired: ["pnpm test"],
      })
    );

    const output = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
    assert.equal(output.decision, "stop");
  } finally {
    cleanState();
  }
});

test("v5: post-tool telemetry preserves mutationSeq for git status, add, commit, push, and increments on worktree mutation", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      mutationSeq: 10,
      activeRole: "ORCHESTRATOR",
      taskAction: "DIRECT_ACTION",
      directActionType: "GIT_COMMIT_PUSH",
    }));

    // 1. git status
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "run_command",
        toolCall: { name: "run_command", args: { CommandLine: "git status --porcelain" } }
      })
    });
    let state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.mutationSeq, 10);

    // 2. git add
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "run_command",
        toolCall: { name: "run_command", args: { CommandLine: "git add packages/core/src/index.ts" } }
      })
    });
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.mutationSeq, 10);

    // 3. git commit
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "run_command",
        toolCall: { name: "run_command", args: { CommandLine: "git commit -m 'chore: direct commit'" } }
      })
    });
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.mutationSeq, 10);

    // 4. git push
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "run_command",
        toolCall: { name: "run_command", args: { CommandLine: "git push origin main" } }
      })
    });
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.mutationSeq, 10);

    // Check direct action tool calls tracking
    assert.equal(state.toolMix.direct_action_tool_calls, 4);
    assert.equal(state.toolMix.git_commit_push_tool_calls, 4);

    // 5. Worktree mutating checkout touches product code -> mutationSeq MUST increment
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        toolName: "run_command",
        toolCall: { name: "run_command", args: { CommandLine: "git checkout packages/core/src/dsp.ts" } }
      })
    });
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.mutationSeq, 11);
  } finally {
    cleanState();
  }
});

test("v5: git-operation resolves root transaction state from nested cwd", () => {
  const fixtureDir = resolve("scratch/git-fixture-root-state-" + Date.now());
  const nestedDir = resolve(fixtureDir, "src/nested");
  try {
    mkdirSync(nestedDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "AutoEQ Test"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@autoeq.local"], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "README.md"), "# Fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: fixtureDir });
    execFileSync("git", ["commit", "-m", "initial fixture"], { cwd: fixtureDir });

    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixtureDir, encoding: "utf-8" }).trim();
    const stateDir = resolve(fixtureDir, ".agents/state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(resolve(stateDir, "active-state.json"), JSON.stringify({
      gitTransaction: {
        action: "commit",
        commitCreated: true,
        commitHash: head,
        message: "candidate already committed",
        files: null,
        remote: "origin",
        branch: "main",
        pushSucceeded: false,
      },
    }, null, 2), "utf-8");

    const res = executeGitOperation({
      cwd: nestedDir,
      action: "commit",
      message: "candidate already committed",
    });

    assert.equal(res.success, true);
    assert.equal(res.action, "commit");
    assert.equal(res.commit, head, "Nested invocation must reuse transaction state from repository root");
    assert.equal(
      existsSync(resolve(nestedDir, ".git/active-state.json")),
      false,
      "Nested cwd must never create or depend on a local .git/active-state.json"
    );
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  }
});

test("v5: git-operation runner executes status and diff_summary", () => {
  const fixtureDir = resolve("scratch/git-fixture-status-" + Date.now());
  try {
    mkdirSync(fixtureDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "AutoEQ Test"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@autoeq.local"], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "README.md"), "# Test Repo\n");

    const resStatus = executeGitOperation({ cwd: fixtureDir, action: "status" });
    assert.equal(resStatus.success, true);
    assert(resStatus.output.includes("GIT_OPERATION_SUCCESS"));
    assert.equal(resStatus.parsed.untracked.length, 1);

    const resDiff = executeGitOperation({ cwd: fixtureDir, action: "diff_summary" });
    assert.equal(resDiff.success, true);
    assert(resDiff.output.includes("GIT_OPERATION_SUCCESS"));
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  }
});

test("v5: git-operation runner stages ONLY intended files, never uses git add . blindly", () => {
  cleanState();
  const bareDir = resolve("scratch/git-bare-" + Date.now());
  const fixtureDir = resolve("scratch/git-fixture-commit-" + Date.now());
  try {
    mkdirSync(bareDir, { recursive: true });
    execFileSync("git", ["init", "--bare"], { cwd: bareDir });

    mkdirSync(fixtureDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "AutoEQ Test"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@autoeq.local"], { cwd: fixtureDir });
    execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "init.txt"), "init\n");
    execFileSync("git", ["add", "init.txt"], { cwd: fixtureDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: fixtureDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "target.ts"), "export const a = 1;\n");
    writeFileSync(resolve(fixtureDir, "wip.ts"), "unintended WIP\n");

    const res = executeGitOperation({
      cwd: fixtureDir,
      action: "commit_push",
      files: ["target.ts"],
      message: "feat: add target only",
      remote: "origin",
      branch: "main",
    });

    assert.equal(res.success, true);
    assert.equal(res.commitCreated, true);
    assert(res.output.includes("GIT_OPERATION_SUCCESS"));
    assert(res.output.includes("push: success"));

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: fixtureDir, encoding: "utf-8" });
    assert(status.includes("?? wip.ts"));
    assert(!status.includes("target.ts"));
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
    try { rmSync(bareDir, { recursive: true, force: true }); } catch {}
    cleanState();
  }
});

test("v5: git-operation runner blocks on unexpected sensitive file (unrelated-secret.txt)", () => {
  cleanState();
  const fixtureDir = resolve("scratch/git-fixture-secret-" + Date.now());
  try {
    mkdirSync(fixtureDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "AutoEQ Test"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@autoeq.local"], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "A.ts"), "export const a = 1;\n");
    writeFileSync(resolve(fixtureDir, "unrelated-secret.txt"), "SUPER_SECRET_KEY=12345\n");

    const res = executeGitOperation({
      cwd: fixtureDir,
      action: "commit_push",
      files: ["A.ts"],
      message: "feat: should block",
    });

    assert.equal(res.success, false);
    assert.equal(res.blocked, true);
    assert.equal(res.reason, "unexpected_dirty_paths");
    assert(res.output.includes("DIRECT_ACTION_BLOCKED"));
    assert(res.output.includes("unrelated-secret.txt"));

    const logRes = execFileSync("git", ["status", "--porcelain"], { cwd: fixtureDir, encoding: "utf-8" });
    assert(logRes.includes("?? A.ts"));
    assert(logRes.includes("?? unrelated-secret.txt"));
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
    cleanState();
  }
});

test("v5: git-operation runner handles trailing whitespace without spawning worker or altering files", () => {
  cleanState();
  const fixtureDir = resolve("scratch/git-fixture-ws-" + Date.now());
  try {
    mkdirSync(fixtureDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "AutoEQ Test"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@autoeq.local"], { cwd: fixtureDir });

    const content = "export const x = 1;   \nexport const y = 2;\t\n";
    writeFileSync(resolve(fixtureDir, "test.ts"), content);

    const res = executeGitOperation({
      cwd: fixtureDir,
      action: "commit",
      files: ["test.ts"],
      message: "feat: trailing whitespace commit",
    });

    assert.equal(res.success, true);
    assert(res.output.includes("GIT_OPERATION_SUCCESS"));

    const current = readFileSync(resolve(fixtureDir, "test.ts"), "utf-8");
    assert.equal(current, content);
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
    cleanState();
  }
});

test("v5: git-operation runner handles pre-commit hook failure cleanly without auto-fixing", () => {
  cleanState();
  const fixtureDir = resolve("scratch/git-fixture-hookfail-" + Date.now());
  try {
    mkdirSync(fixtureDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "AutoEQ Test"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@autoeq.local"], { cwd: fixtureDir });

    const hooksDir = resolve(fixtureDir, ".git/hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = resolve(hooksDir, "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho 'HOOK ERROR: strict linter failed' >&2\nexit 1\n", { mode: 0o755 });

    writeFileSync(resolve(fixtureDir, "file.ts"), "const z = 1;\n");

    const res = executeGitOperation({
      cwd: fixtureDir,
      action: "commit",
      files: ["file.ts"],
      message: "feat: should fail hook",
    });

    assert.equal(res.success, false);
    assert.equal(res.blocked, true);
    assert(res.output.includes("DIRECT_ACTION_BLOCKED"));
    assert(res.output.includes("pre-commit hook failed"));
    assert(res.output.includes("HOOK ERROR: strict linter failed"));
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
    cleanState();
  }
});

test("v5: git-operation runner idempotency and push partial failure recovery", () => {
  cleanState();
  const bareDir = resolve("scratch/git-bare-partial-" + Date.now());
  const fixtureDir = resolve("scratch/git-fixture-partial-" + Date.now());
  try {
    mkdirSync(bareDir, { recursive: true });
    execFileSync("git", ["init", "--bare"], { cwd: bareDir });

    mkdirSync(fixtureDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "AutoEQ Test"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@autoeq.local"], { cwd: fixtureDir });
    execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "init.txt"), "init\n");
    execFileSync("git", ["add", "init.txt"], { cwd: fixtureDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: fixtureDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "feature.ts"), "export const feat = true;\n");

    const res1 = executeGitOperation({
      cwd: fixtureDir,
      action: "commit_push",
      files: ["feature.ts"],
      message: "feat: partial push fail",
      remote: "non_existent_remote",
      branch: "main",
    });

    assert.equal(res1.success, false);
    assert.equal(res1.blocked, true);
    assert.equal(res1.commitCreated, true);
    assert.equal(res1.pushSucceeded, false);
    assert(res1.output.includes("commit succeeded but push failed (partial failure)"));
    const firstCommitHash = res1.commit;
    assert.ok(firstCommitHash);

    const res2 = executeGitOperation({
      cwd: fixtureDir,
      action: "commit_push",
      files: ["feature.ts"],
      message: "feat: partial push fail",
      remote: "origin",
      branch: "main",
    });

    assert.equal(res2.success, true);
    assert.equal(res2.commit, firstCommitHash);
    assert(res2.output.includes("GIT_OPERATION_SUCCESS"));
    assert(res2.output.includes("push: success"));
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
    try { rmSync(bareDir, { recursive: true, force: true }); } catch {}
    cleanState();
  }
});

test("pre-tool hook: fails closed with ROLE_IDENTITY_UNRESOLVED on workspace write when role is unknown", () => {
  cleanState();
  try {
    const input = JSON.stringify({
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("src/new-feature.ts") },
      },
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("ROLE_IDENTITY_UNRESOLVED"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: blocks orchestrator workspace writes across the full layout matrix", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    const matrixPaths = [
      "src/formatter.ts",
      "lib/utils.js",
      "packages/core/index.ts",
      "apps/web/main.tsx",
      "test/formatter.test.js",
      "docs/architecture.md",
      "config/default.json",
      "scripts/build.sh",
      "README.md",
    ];

    for (const relPath of matrixPaths) {
      const input = JSON.stringify({
        toolCall: {
          name: "write_to_file",
          args: { TargetFile: resolve(relPath) },
        },
      });
      const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
      assert.equal(output.decision, "deny", `Orchestrator write to ${relPath} must be denied`);
      assert(
        output.reason.includes("ORCHESTRATOR_WORKSPACE_WRITE_PROHIBITED"),
        `Expected ORCHESTRATOR_WORKSPACE_WRITE_PROHIBITED for ${relPath}, got ${output.reason}`
      );
    }
  } finally {
    cleanState();
  }
});

test("pre-tool hook: orchestrator may write scratch but not hook-owned .agents or AGENTS.md", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    const allowedScratch = [
      "scratch/experiment.py",
      "scratch/debug-notes.txt",
    ];

    for (const relPath of allowedScratch) {
      const input = JSON.stringify({
        toolCall: {
          name: "write_to_file",
          args: { TargetFile: resolve(relPath) },
        },
      });
      const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
      assert.equal(output.decision, "allow", `Orchestrator scratch write to ${relPath} should be allowed`);
    }

    const hookOwned = [
      ".agents/state/active-state.json",
      ".agents/state/active-contract.json",
      ".agents/evidence/ledger.json",
    ];
    for (const relPath of hookOwned) {
      const input = JSON.stringify({
        toolCall: {
          name: "write_to_file",
          args: { TargetFile: resolve(relPath) },
        },
      });
      const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
      assert.equal(output.decision, "deny", `Orchestrator direct write to ${relPath} must be denied`);
      assert.match(output.reason, /HOOK_OWNED_GOVERNANCE_STATE/);
    }

    const agentsMdInput = JSON.stringify({
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("AGENTS.md") },
      },
    });
    const agentsMdOutput = JSON.parse(execFileSync("node", [preToolScript], { input: agentsMdInput }));
    assert.equal(agentsMdOutput.decision, "deny");
    assert(agentsMdOutput.reason.includes("AGENTS.md is the provider-neutral repository constitution"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: blocks orchestrator shell mutations but permits read-only commands", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    // Mutating shell commands
    const mutatingCommands = [
      "rm -rf src/old.js",
      "echo 'alert()' > src/index.js",
      "cat new.js > lib/core.js",
      "sed -i 's/foo/bar/g' src/file.js",
    ];

    for (const cmd of mutatingCommands) {
      const input = JSON.stringify({
        toolCall: {
          name: "run_command",
          args: { CommandLine: cmd },
        },
      });
      const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
      assert.equal(output.decision, "deny", `Shell mutation '${cmd}' must be denied`);
      assert(output.reason.includes("ORCHESTRATOR_WORKSPACE_WRITE_PROHIBITED"));
    }

    // Commands that look read-only by prefix but have side effects or shell escape surfaces.
    const deceptiveReadOnlyCommands = [
      "git branch audit-bypass",
      "git branch -D audit-bypass",
      "git diff --output=audit.patch",
      "find src -delete",
      "git status $(python -c \"from pathlib import Path; Path('pwned').write_text('x')\")",
    ];

    for (const cmd of deceptiveReadOnlyCommands) {
      const input = JSON.stringify({
        toolCall: {
          name: "run_command",
          args: { CommandLine: cmd },
        },
      });
      const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
      assert.equal(output.decision, "deny", `Deceptive read-only command '${cmd}' must fail closed`);
      assert.match(output.reason, /ORCHESTRATOR_UNVERIFIED_COMMAND_PROHIBITED|ORCHESTRATOR_WORKSPACE_WRITE_PROHIBITED/);
    }

    // Read-only shell commands
    const readOnlyCommands = [
      "git status",
      "git diff",
      "node --test test/formatter.test.js",
      "npm test",
    ];

    for (const cmd of readOnlyCommands) {
      const input = JSON.stringify({
        toolCall: {
          name: "run_command",
          args: { CommandLine: cmd },
        },
      });
      const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
      assert.equal(output.decision, "allow", `Read-only shell '${cmd}' should be allowed`);
    }
  } finally {
    cleanState();
  }
});

test("pre-tool hook: pending uniqueness is not factual identity; brain record upgrades provisional child", () => {
  cleanState();
  const brainBaseDir = resolve("scratch/identity-brain");
  try {
    seedFactualOrchestratorIdentity("parent-conv-1");
    const invokeInput = JSON.stringify({
      conversationId: "parent-conv-1",
      stepIdx: 6,
      toolCall: {
        id: "call-worker-identity",
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              TypeName: "worker",
              Role: "Implementation Worker",
              Model: "flash_lite",
              Prompt: "Fix the bug in src/formatter.js",
            },
          ],
        },
      },
    });
    const invokeOutput = JSON.parse(execFileSync("node", [preToolScript], { input: invokeInput }));
    assert.equal(invokeOutput.decision, "allow");

    const bindingsPath = resolve(".agents/state/role-bindings.json");
    let bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.equal(bindings.pendingSubagents.length, 1);
    assert.equal(bindings.pendingSubagents[0].role, "WORKER");
    assert.equal(bindings.pendingSubagents[0].originStepIdx, 6);
    assert.equal(bindings.pendingSubagents[0].model, "gemini-3.8-flash-low", "Pending identity stores canonical runtime model, not flash_lite alias");

    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      taskDomain: "CODE",
      allowedPaths: ["src/**"],
    }));

    // A single pending delegation is not proof of child identity.
    const noProofInput = JSON.stringify({
      conversationId: "child-conv-42",
      parentConversationId: "parent-conv-1",
      toolCall: {
        id: "call-child-no-proof",
        name: "write_to_file",
        args: { TargetFile: resolve("src/formatter.js") },
      },
    });
    const noProofOutput = JSON.parse(execFileSync("node", [preToolScript], { input: noProofInput }));
    assert.equal(noProofOutput.decision, "deny");
    assert.match(noProofOutput.reason, /ROLE_IDENTITY_UNRESOLVED/);

    bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.equal(bindings.pendingSubagents[0].consumed, false);
    assert.equal(bindings.bindings["child-conv-42"], undefined);

    // Runtime hook metadata may provisionally correlate the child for authorization,
    // but it must remain MEDIUM and must not claim factual runtime identity.
    const provisionalInput = JSON.stringify({
      conversationId: "child-conv-42",
      parentConversationId: "parent-conv-1",
      agentRole: "WORKER",
      agentProfile: "flash-low-worker",
      modelName: "gemini-3.8-flash-low",
      toolCall: {
        id: "call-child-provisional",
        name: "view_file",
        args: { AbsolutePath: resolve("package.json") },
      },
    });
    const provisionalOutput = JSON.parse(execFileSync("node", [preToolScript], { input: provisionalInput }));
    assert.equal(provisionalOutput.decision, "allow");

    bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.equal(bindings.bindings["child-conv-42"], undefined, "Provisional hook metadata must not create durable child identity");
    assert.equal(bindings.pendingSubagents[0].consumed, false, "Provisional authorization must not consume the pending factual identity slot");

    const provisionalWrite = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "child-conv-42",
        parentConversationId: "parent-conv-1",
        agentRole: "WORKER",
        agentProfile: "flash-low-worker",
        toolCall: {
          id: "call-child-provisional-write",
          name: "write_to_file",
          args: { TargetFile: resolve("src/formatter.js"), CodeContent: "export const provisional = true;" },
        },
      }),
    }));
    assert.equal(provisionalWrite.decision, "deny");
    assert.match(provisionalWrite.reason, /ROLE_IDENTITY_NOT_FACTUAL/);

    const provisionalShellWrite = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "child-conv-42",
        parentConversationId: "parent-conv-1",
        agentRole: "WORKER",
        agentProfile: "flash-low-worker",
        toolCall: {
          id: "call-child-provisional-shell",
          name: "run_command",
          args: { CommandLine: "touch src/provisional-created.js" },
        },
      }),
    }));
    assert.equal(provisionalShellWrite.decision, "deny");
    assert.match(provisionalShellWrite.reason, /ROLE_IDENTITY_NOT_FACTUAL/);

    // The factual Antigravity brain record for the exact child creates the
    // durable HIGH/RUNTIME_IDENTITY binding.
    const subagentsDir = resolve(brainBaseDir, "parent-conv-1/.system_generated/subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(resolve(subagentsDir, "child-conv-42.json"), JSON.stringify({
      conversationId: "child-conv-42",
      subagentDescriptor: {
        typeName: "flash-low-worker",
        role: "Worker",
      },
      spawnStepIndex: 6,
    }, null, 2), "utf-8");

    const factualOutput = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "child-conv-42",
        parentConversationId: "parent-conv-1",
        toolCall: {
          id: "call-child-factual",
          name: "view_file",
          args: { AbsolutePath: resolve("package.json") },
        },
      }),
      env: { ...process.env, AGY_BRAIN_DIR: brainBaseDir },
    }));
    assert.equal(factualOutput.decision, "allow");

    bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.equal(bindings.bindings["child-conv-42"].confidence, "HIGH");
    assert.equal(bindings.bindings["child-conv-42"].source, "RUNTIME_IDENTITY");
    assert.ok(bindings.bindings["child-conv-42"].factualIdentityAt);

    const factualWrite = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "child-conv-42",
        parentConversationId: "parent-conv-1",
        toolCall: {
          id: "call-child-factual-write",
          name: "write_to_file",
          args: { TargetFile: resolve("src/formatter.js"), CodeContent: "export const factual = true;" },
        },
      }),
      env: { ...process.env, AGY_BRAIN_DIR: brainBaseDir },
    }));
    assert.equal(factualWrite.decision, "allow", "Factual runtime identity restores worker mutation authority within Scope Contract");
  } finally {
    cleanState();
  }
});

test("pre-tool hook: allows worker to write within scope contract but denies out-of-scope files", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));
    const workerConv = seedFactualWorkerIdentity("scope-contract-worker");
    writeFileSync(
      ".agents/state/active-contract.json",
      JSON.stringify({
        taskDomain: "CODE",
        allowedPaths: ["src/**"],
        forbiddenPaths: ["packages/core/**"],
      })
    );

    // In-scope write
    const inScopeInput = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("src/formatter.js") },
      },
    });
    const inScopeOutput = JSON.parse(execFileSync("node", [preToolScript], { input: inScopeInput }));
    assert.equal(inScopeOutput.decision, "allow");

    // Out-of-scope write
    const outOfScopeInput = JSON.stringify({
      conversationId: workerConv,
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("packages/core/secret.ts") },
      },
    });
    const outOfScopeOutput = JSON.parse(execFileSync("node", [preToolScript], { input: outOfScopeInput }));
    assert.equal(outOfScopeOutput.decision, "deny");
    assert(outOfScopeOutput.reason.includes("SCOPE_VIOLATION"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: active contract with UNKNOWN actor remains UNKNOWN and write is DENIED", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    // Active contract exists, but no role is bound to the actor
    writeFileSync(
      ".agents/state/active-contract.json",
      JSON.stringify({
        taskDomain: "CODE",
        allowedPaths: ["src/**"],
      })
    );
    // Unresolved conversation with no roleBindings entry
    const input = JSON.stringify({
      conversationId: "unknown-conv-xyz",
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("src/formatter.js") },
      },
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("ROLE_IDENTITY_UNRESOLVED"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: UNKNOWN actor writing to control plane .agents/state/foo.json is DENIED", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    const input = JSON.stringify({
      conversationId: "unknown-actor-conv",
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve(".agents/state/foo.json") },
      },
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert(output.reason.includes("ROLE_IDENTITY_UNRESOLVED"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: ORCHESTRATOR direct write to .agents/state/foo.json is DENIED", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(
      ".agents/state/active-state.json",
      JSON.stringify({ activeRole: "ORCHESTRATOR" })
    );
    const input = JSON.stringify({
      conversationId: "orch-conv-1",
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve(".agents/state/foo.json") },
      },
    });
    const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
    assert.equal(output.decision, "deny");
    assert.match(output.reason, /HOOK_OWNED_GOVERNANCE_STATE/);
  } finally {
    cleanState();
  }
});

test("pre-tool hook: ambiguous identical workers fail closed instead of FIFO binding", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
    }, null, 2), "utf-8");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      contractId: "ambiguous-workers",
      allowedPaths: ["src/**"],
      forbiddenPaths: [".agents/**"],
      testsRequired: [],
    }, null, 2), "utf-8");
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
      mainConversationId: "ambiguous-parent",
      bindings: {
        "ambiguous-parent": {
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          source: "CONVERSATION_BOUND_IDENTITY",
        },
      },
      conversations: {},
      pendingSubagents: [
        {
          seq: 1,
          parentConversationId: "ambiguous-parent",
          role: "WORKER",
          profile: "flash-medium-worker",
          model: "gemini-3.8-flash-medium",
          delegationKind: "WORK",
          consumed: false,
          decisionCorrelationKey: "corr-worker-a",
        },
        {
          seq: 2,
          parentConversationId: "ambiguous-parent",
          role: "WORKER",
          profile: "flash-medium-worker",
          model: "gemini-3.8-flash-medium",
          delegationKind: "WORK",
          consumed: false,
          decisionCorrelationKey: "corr-worker-b",
        },
      ],
    }, null, 2), "utf-8");

    const output = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "ambiguous-child",
        parentConversationId: "ambiguous-parent",
        toolCall: {
          id: "ambiguous-write",
          name: "write_to_file",
          args: { TargetFile: "src/ambiguous.ts", CodeContent: "export const x = 1;" },
        },
      }),
      encoding: "utf-8",
    }).trim());

    assert.equal(output.decision, "deny");
    assert.match(output.reason, /ROLE_IDENTITY_UNRESOLVED/);

    const bindings = JSON.parse(readFileSync(".agents/state/role-bindings.json", "utf-8"));
    assert.equal(bindings.pendingSubagents.filter(p => p.consumed).length, 0, "Ambiguous workers must not be consumed FIFO");
    assert.equal(bindings.bindings["ambiguous-child"], undefined, "Ambiguous child must not receive a guessed worker binding");
  } finally {
    cleanState();
  }
});

test("pre-tool hook: multi-worker batch fails closed to prevent scope-contract aliasing", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    seedFactualOrchestratorIdentity("orch-main");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({ allowedPaths: ["src/**"] }));

    const invokeInput = JSON.stringify({
      conversationId: "orch-main",
      toolCall: {
        name: "invoke_subagent",
        args: {
          Subagents: [
            { TypeName: "flash-low-worker", Role: "Worker 1", Model: "flash_lite", Prompt: "Task 1. allowedPaths: [src/a/**]" },
            { TypeName: "flash-worker", Role: "Worker 2", Model: "pro", Prompt: "Task 2. allowedPaths: [src/b/**]" },
          ],
        },
      },
    });

    const invokeOutput = JSON.parse(execFileSync("node", [preToolScript], { input: invokeInput }));
    assert.equal(invokeOutput.decision, "deny");
    assert.match(invokeOutput.reason, /PARALLEL_MUTATING_SUBAGENTS_UNSUPPORTED/);

    const bindingsPath = resolve(".agents/state/role-bindings.json");
    if (existsSync(bindingsPath)) {
      const bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
      assert.equal(bindings.pendingSubagents?.length ?? 0, 0, "Denied batch must not create pending worker identities");
    }
  } finally {
    cleanState();
  }
});

test("pre-tool hook: reviewer pending binds REVIEWER role and remains strictly read-only", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    seedFactualOrchestratorIdentity("orch-main");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({ allowedPaths: ["src/**"] }));

    // Orchestrator invokes two Two-Key reviewers
    const invokeInput = JSON.stringify({
      conversationId: "orch-main",
      toolCall: {
        name: "invoke_subagent",
        args: {
          Subagents: [
            { TypeName: "flash-reviewer", Role: "Two-Key Reviewer A", Model: "pro", Prompt: "Review parser" },
            { TypeName: "flash-reviewer", Role: "Two-Key Reviewer B", Model: "pro", Prompt: "Review parser" },
          ],
        },
      },
    });
    const invokeOutput = JSON.parse(execFileSync("node", [preToolScript], { input: invokeInput }));
    assert.equal(invokeOutput.decision, "allow");

    // Reviewer A calls write_to_file -> must be DENIED as Reviewer
    const revAInput = JSON.stringify({
      conversationId: "rev-conv-a",
      parentConversationId: "orch-main",
      agentRole: "REVIEWER",
      agentProfile: "flash-reviewer",
      modelName: "gemini-3.8-flash-high",
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("src/formatter.js") },
      },
    });
    const revAOutput = JSON.parse(execFileSync("node", [preToolScript], { input: revAInput }));
    assert.equal(revAOutput.decision, "deny");
    assert(revAOutput.reason.includes("Reviewer is strictly read-only"));

    // Reviewer B calls run_command -> must be DENIED as Reviewer
    const revBInput = JSON.stringify({
      conversationId: "rev-conv-b",
      parentConversationId: "orch-main",
      agentRole: "REVIEWER",
      agentProfile: "flash-reviewer",
      modelName: "gemini-3.8-flash-high",
      toolCall: {
        name: "run_command",
        args: { CommandLine: "node --test test/formatter.test.js" },
      },
    });
    const revBOutput = JSON.parse(execFileSync("node", [preToolScript], { input: revBInput }));
    assert.equal(revBOutput.decision, "deny");
    assert(revBOutput.reason.includes("Reviewer is strictly read-only"));

    // Provisional reviewer hook metadata is sufficient to apply the conservative
    // read-only policy, but must not create durable identity or consume a factual slot.
    const bindingsPath = resolve(".agents/state/role-bindings.json");
    const bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.equal(bindings.bindings["rev-conv-a"], undefined);
    assert.equal(bindings.bindings["rev-conv-b"], undefined);
    assert.equal(bindings.pendingSubagents.length, 2);
    assert.equal(bindings.pendingSubagents[0].consumed, false);
    assert.equal(bindings.pendingSubagents[1].consumed, false);
  } finally {
    cleanState();
  }
});

test("pre-tool hook: arbitrary orchestrator command is denied in normal mode and allowed in direct action script mode", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    // 1. Normal orchestration mode: arbitrary command is denied
    const normalInput = JSON.stringify({
      conversationId: "orch-conv-main",
      toolCall: {
        name: "run_command",
        args: { CommandLine: "node scripts/unknown.js" },
      },
    });
    const normalOutput = JSON.parse(execFileSync("node", [preToolScript], { input: normalInput }));
    assert.equal(normalOutput.decision, "deny");
    assert(normalOutput.reason.includes("ORCHESTRATOR_UNVERIFIED_COMMAND_PROHIBITED"));

    // 2. Python / bash / pwsh arbitrary scripts also denied in normal mode
    const pyInput = JSON.stringify({
      conversationId: "orch-conv-main",
      toolCall: {
        name: "run_command",
        args: { CommandLine: "python arbitrary-script.py" },
      },
    });
    const pyOutput = JSON.parse(execFileSync("node", [preToolScript], { input: pyInput }));
    assert.equal(pyOutput.decision, "deny");
    assert(pyOutput.reason.includes("ORCHESTRATOR_UNVERIFIED_COMMAND_PROHIBITED"));

    // 3. Direct action with explicit script run is allowed
    writeFileSync(
      ".agents/state/active-state.json",
      JSON.stringify({
        activeRole: "ORCHESTRATOR",
        taskAction: "DIRECT_ACTION",
        directActionType: "RUN_PROJECT_SCRIPT",
      })
    );
    const directScriptInput = JSON.stringify({
      conversationId: "orch-conv-main",
      toolCall: {
        name: "run_command",
        args: { CommandLine: "node scripts/unknown.js" },
      },
    });
    const directScriptOutput = JSON.parse(execFileSync("node", [preToolScript], { input: directScriptInput }));
    assert.equal(directScriptOutput.decision, "allow");
  } finally {
    cleanState();
  }
});


test("v5: git-operation explicit files blocks unrelated pre-staged paths", () => {
  cleanState();
  const fixtureDir = resolve("scratch/git-fixture-prestaged-" + Date.now());
  try {
    mkdirSync(fixtureDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "AutoEQ Test"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@autoeq.local"], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "init.txt"), "init\n");
    execFileSync("git", ["add", "init.txt"], { cwd: fixtureDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: fixtureDir });
    const beforeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixtureDir, encoding: "utf-8" }).trim();

    writeFileSync(resolve(fixtureDir, "target.ts"), "export const target = true;\n");
    writeFileSync(resolve(fixtureDir, "unrelated.ts"), "export const unrelated = true;\n");
    execFileSync("git", ["add", "unrelated.ts"], { cwd: fixtureDir });

    const res = executeGitOperation({
      cwd: fixtureDir,
      action: "commit",
      files: ["target.ts"],
      message: "feat: target only",
    });

    assert.equal(res.success, false);
    assert.equal(res.blocked, true);
    assert.equal(res.reason, "unexpected_staged_paths");
    assert.deepEqual(res.unexpectedFiles, ["unrelated.ts"]);

    const afterHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixtureDir, encoding: "utf-8" }).trim();
    assert.equal(afterHead, beforeHead, "Blocked scoped commit must not create a commit");

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: fixtureDir, encoding: "utf-8" }).trim();
    assert.equal(staged, "unrelated.ts", "Existing staged work must remain untouched, not silently committed");
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
    cleanState();
  }
});

test("v5: git-operation stages repo-relative explicit files from nested cwd", () => {
  cleanState();
  const fixtureDir = resolve("scratch/git-fixture-nested-stage-" + Date.now());
  const nestedDir = resolve(fixtureDir, "src/nested");
  try {
    mkdirSync(nestedDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "AutoEQ Test"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@autoeq.local"], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "init.txt"), "init\n");
    execFileSync("git", ["add", "init.txt"], { cwd: fixtureDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "src/target.ts"), "export const nested = true;\n");

    const res = executeGitOperation({
      cwd: nestedDir,
      action: "commit",
      files: ["src/target.ts"],
      message: "feat: nested scoped commit",
    });

    assert.equal(res.success, true);
    const changed = execFileSync("git", ["show", "--pretty=", "--name-only", "HEAD"], {
      cwd: fixtureDir,
      encoding: "utf-8",
    }).trim();
    assert.equal(changed, "src/target.ts");
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
    cleanState();
  }
});



test("v5: git-operation does not reuse stale transaction state for a new commit", () => {
  cleanState();
  const fixtureDir = resolve("scratch/git-fixture-stale-tx-" + Date.now());
  try {
    mkdirSync(resolve(fixtureDir, ".agents/state"), { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.name", "AutoEQ Test"], { cwd: fixtureDir });
    execFileSync("git", ["config", "user.email", "test@autoeq.local"], { cwd: fixtureDir });

    writeFileSync(resolve(fixtureDir, "init.txt"), "init\n");
    execFileSync("git", ["add", "init.txt"], { cwd: fixtureDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: fixtureDir });
    const oldHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixtureDir, encoding: "utf8" }).trim();

    writeFileSync(resolve(fixtureDir, ".agents/state/active-state.json"), JSON.stringify({
      gitTransaction: {
        action: "commit",
        commitCreated: true,
        commitHash: oldHead,
        message: "feat: old transaction",
        files: ["old.ts"],
        remote: "origin",
        branch: "main",
        pushSucceeded: false,
      },
    }, null, 2), "utf8");

    writeFileSync(resolve(fixtureDir, "target.ts"), "export const target = 2;\n");

    const res = executeGitOperation({
      cwd: fixtureDir,
      action: "commit",
      files: ["target.ts"],
      message: "feat: new transaction",
    });

    assert.equal(res.success, true);
    const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixtureDir, encoding: "utf8" }).trim();
    assert.notEqual(newHead, oldHead, "Stale transaction state must not suppress a new commit");
    assert.equal(res.commit, newHead, "Result must report the newly-created factual HEAD");

    const changed = execFileSync("git", ["show", "--pretty=", "--name-only", "HEAD"], {
      cwd: fixtureDir,
      encoding: "utf8",
    }).trim();
    assert.equal(changed, "target.ts");
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
    cleanState();
  }
});

test("pre-tool hook: factual INVESTIGATION delegation is strictly read-only", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
    }, null, 2), "utf-8");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      contractId: "investigator-read-only",
      allowedPaths: ["src/**"],
      forbiddenPaths: [".agents/**"],
      testsRequired: [],
    }, null, 2), "utf-8");
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
      mainConversationId: "investigator-parent",
      bindings: {
        "investigator-parent": {
          conversationId: "investigator-parent",
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          confidence: "HIGH",
          source: "CONVERSATION_BOUND_IDENTITY",
        },
        "investigator-child": {
          conversationId: "investigator-child",
          role: "WORKER",
          profile: "flash-worker",
          parentConversationId: "investigator-parent",
          delegationKind: "INVESTIGATION",
          originToolCallId: "call-investigator",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
          consumed: true,
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2), "utf-8");

    const write = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "investigator-child",
        parentConversationId: "investigator-parent",
        toolCall: {
          id: "investigator-write",
          name: "write_to_file",
          args: { TargetFile: "src/investigator.ts", CodeContent: "export const bad = true;" },
        },
      }),
      encoding: "utf-8",
    }).trim());
    assert.equal(write.decision, "deny");
    assert.match(write.reason, /INVESTIGATOR_READ_ONLY/);

    const shellMutation = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "investigator-child",
        parentConversationId: "investigator-parent",
        toolCall: {
          id: "investigator-shell-write",
          name: "run_command",
          args: { CommandLine: "touch src/investigator-created.ts" },
        },
      }),
      encoding: "utf-8",
    }).trim());
    assert.equal(shellMutation.decision, "deny");
    assert.match(shellMutation.reason, /INVESTIGATOR_READ_ONLY/);

    const read = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "investigator-child",
        parentConversationId: "investigator-parent",
        toolCall: {
          id: "investigator-read",
          name: "view_file",
          args: { AbsolutePath: resolve("package.json") },
        },
      }),
      encoding: "utf-8",
    }).trim());
    assert.equal(read.decision, "allow");

    const gitStatus = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "investigator-child",
        parentConversationId: "investigator-parent",
        toolCall: {
          id: "investigator-git-status",
          name: "run_command",
          args: { CommandLine: "git status --short" },
        },
      }),
      encoding: "utf-8",
    }).trim());
    assert.equal(gitStatus.decision, "allow");

    const testCommand = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "investigator-child",
        parentConversationId: "investigator-parent",
        toolCall: {
          id: "investigator-test",
          name: "run_command",
          args: { CommandLine: "node --test test/example.test.js" },
        },
      }),
      encoding: "utf-8",
    }).trim());
    assert.equal(testCommand.decision, "allow", "Read-only validation is permitted for investigation");

    const buildCommand = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "investigator-child",
        parentConversationId: "investigator-parent",
        toolCall: {
          id: "investigator-build",
          name: "run_command",
          args: { CommandLine: "npm run build" },
        },
      }),
      encoding: "utf-8",
    }).trim());
    assert.equal(buildCommand.decision, "deny", "Build is workspace-mutating and forbidden to investigator");
    assert.match(buildCommand.reason, /INVESTIGATOR_READ_ONLY/);
  } finally {
    cleanState();
  }
});


test("governance: native write aliases are intercepted, scoped, and tracked", () => {
  cleanState();
  try {
    const hooksConfig = JSON.parse(readFileSync(resolve(__dirname, "../hooks.json"), "utf8"));
    const matcher = hooksConfig["scope-enforcer"].PreToolUse[0].matcher;
    assert.match(matcher, /(?:^|\|)edit_file(?:\||$)/);
    assert.match(matcher, /(?:^|\|)create_file(?:\||$)/);

    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "WORKER",
      taskAction: "IMPLEMENT",
      mutationSeq: 1,
    }, null, 2), "utf8");
    const workerConv = seedFactualWorkerIdentity("alias-worker");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["src/**"],
      forbiddenPaths: [".agents/**"],
    }, null, 2), "utf8");

    const createAllowed = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolCall: {
          id: "alias-create",
          name: "create_file",
          args: { path: "src/alias-created.js", content: "export const x = 1;" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(createAllowed.decision, "allow");

    const editDenied = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolCall: {
          id: "alias-edit",
          name: "edit_file",
          args: { path: "docs/outside.md", content: "nope" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(editDenied.decision, "deny");
    assert.match(editDenied.reason, /SCOPE_VIOLATION/);

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolName: "create_file",
        toolCall: {
          id: "alias-create",
          name: "create_file",
          args: { path: "src/alias-created.js", content: "export const x = 1;" },
        },
        result: { status: "SUCCESS" },
      }),
      encoding: "utf8",
    });

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf8"));
    assert.equal(state.write_tool_calls, 1);
    assert.equal(state.workerWorkspaceWrites, 1);
    assert.ok(Array.isArray(state.mutations));
    assert.ok(state.mutations.some((m) => Array.isArray(m.paths) && m.paths.includes("src/alias-created.js")));
    assert.ok(state.mutationEvents.some((m) => m.path === "src/alias-created.js" && m.tool === "create_file"));
  } finally {
    cleanState();
  }
});


test("governance: state-derived worker role cannot grant mutation authority", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["src/**"],
      forbiddenPaths: [".agents/**"],
    }));

    const nativeWrite = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "unbound-worker-conv",
        toolCall: {
          name: "write_to_file",
          args: { TargetFile: "src/state-derived.js", CodeContent: "export const bad = true;" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(nativeWrite.decision, "deny");
    assert.match(nativeWrite.reason, /ROLE_IDENTITY_NOT_FACTUAL|ROLE_IDENTITY_UNRESOLVED/);

    const shellWrite = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "unbound-worker-conv",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "touch src/state-derived-shell.js" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(shellWrite.decision, "deny");
    assert.match(shellWrite.reason, /ROLE_IDENTITY_NOT_FACTUAL|ROLE_IDENTITY_UNRESOLVED/);
  } finally {
    cleanState();
  }
});

test("governance: factual worker cannot execute unclassified arbitrary shell", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));
    const workerConv = seedFactualWorkerIdentity("factual-arbitrary-shell-worker");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["src/**"],
      forbiddenPaths: [".agents/**"],
    }));

    const output = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolCall: {
          name: "run_command",
          args: { CommandLine: "node scripts/custom-mutation.js" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(output.decision, "deny");
    assert.match(output.reason, /WORKER_UNVERIFIED_SHELL_COMMAND/);
  } finally {
    cleanState();
  }
});

test("governance: unresolved actor cannot execute validation shell", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    const output = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "unknown-validation-actor",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "npm test" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(output.decision, "deny");
    assert.match(output.reason, /ROLE_IDENTITY_UNRESOLVED/);
  } finally {
    cleanState();
  }
});


test("governance: child Stop cannot inherit orchestrator acceptance authority", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "stop-parent-orchestrator",
      state: "EVIDENCE_READY",
      taskAction: "IMPLEMENT",
      implementationComplete: true,
      workerCompletionClaimed: true,
      workerCompletionClaimFactual: true,
      workerCompletionClaimIdentity: {
        actorId: "two-key-worker",
        source: "RUNTIME_IDENTITY",
        confidence: "HIGH",
        delegationKind: "WORK",
      },
      workerValidationObserved: true,
      workerValidationVerified: true,
      workerValidationFresh: true,
      evidenceLedger: [{
        executionId: "child-stop-evidence",
        command: "node --test test/example.test.js",
        exitCode: 0,
        mutationSeq: 0,
        actorRole: "WORKER",
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      }],
    }, null, 2), "utf8");
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
      mainConversationId: "stop-parent-orchestrator",
      bindings: {
        "stop-parent-orchestrator": {
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          confidence: "HIGH",
          source: "CONVERSATION_BOUND_IDENTITY",
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2), "utf8");

    const output = JSON.parse(execFileSync("node", [stopScript], {
      input: JSON.stringify({
        conversationId: "unbound-child-stop",
        fullyIdle: true,
        terminationReason: "end_turn",
      }),
      encoding: "utf8",
    }));

    assert.equal(output.decision, "stop", "A terminal child Stop must close the child without finalizing parent acceptance");
    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf8"));
    assert.notEqual(state.state, "DONE");
    assert.notEqual(state.acceptanceState, "ACCEPTED");
  } finally {
    cleanState();
  }
});


test("governance: factual child descriptor conflicts fail closed", () => {
  const pending = {
    profile: "flash-low-worker",
    role: "WORKER",
    originStepIdx: 7,
  };

  assert.equal(factualSubagentMatchesPending({
    subagentDescriptor: { typeName: "flash-low-worker", role: "worker" },
    spawnStepIndex: 7,
  }, pending), true);

  assert.equal(factualSubagentMatchesPending({
    subagentDescriptor: { typeName: "flash-worker", role: "worker" },
    spawnStepIndex: 7,
  }, pending), false, "Matching role must not override a conflicting factual profile");

  assert.equal(factualSubagentMatchesPending({
    subagentDescriptor: { typeName: "flash-low-worker", role: "reviewer" },
    spawnStepIndex: 7,
  }, pending), false, "Matching profile must not override a conflicting factual role");

  assert.equal(factualSubagentMatchesPending({
    subagentDescriptor: { typeName: "flash-low-worker", role: "worker" },
    spawnStepIndex: 8,
  }, pending), false, "Spawn-step mismatch must remain fail-closed");
});


test("governance: binding loss cannot promote a child conversation to orchestrator", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "known-main-conversation",
    }, null, 2), "utf8");

    execFileSync("node", [preInvocationScript], {
      input: JSON.stringify({
        conversationId: "unexpected-child-conversation",
        modelName: "gemini-3.8-flash-high",
      }),
      encoding: "utf8",
    });

    const stateAfterInvocation = JSON.parse(readFileSync(".agents/state/active-state.json", "utf8"));
    assert.equal(stateAfterInvocation.conversationId, "known-main-conversation");
    assert.equal(stateAfterInvocation.identityBootstrapRejected?.reason, "KNOWN_MAIN_MISMATCH");

    const bindingsPath = ".agents/state/role-bindings.json";
    if (existsSync(bindingsPath)) {
      const bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
      assert.notEqual(bindings.mainConversationId, "unexpected-child-conversation");
      assert.equal(bindings.bindings?.["unexpected-child-conversation"], undefined);
    }

    const childControlPlaneWrite = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "unexpected-child-conversation",
        toolCall: {
          name: "write_to_file",
          args: {
            TargetFile: ".agents/state/child-escalation.json",
            CodeContent: "{}",
          },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(childControlPlaneWrite.decision, "deny");
    assert.match(childControlPlaneWrite.reason, /ROLE_IDENTITY_UNRESOLVED/);

    const mainControlPlaneWrite = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "known-main-conversation",
        toolCall: {
          name: "write_to_file",
          args: {
            TargetFile: ".agents/state/main-control-plane.json",
            CodeContent: "{}",
          },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(mainControlPlaneWrite.decision, "deny");
    assert.match(mainControlPlaneWrite.reason, /HOOK_OWNED_GOVERNANCE_STATE/);

    const mainScratchWrite = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "known-main-conversation",
        toolCall: {
          name: "write_to_file",
          args: {
            TargetFile: "scratch/main-authorized.txt",
            CodeContent: "ok",
          },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(mainScratchWrite.decision, "allow", "Known main conversation retains orchestrator scratch authority");
  } finally {
    cleanState();
  }
});

test("governance: post-tool telemetry does not attribute unbound child writes to orchestrator", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "telemetry-main",
    }, null, 2), "utf8");

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "telemetry-unbound-child",
        toolName: "write_to_file",
        toolCall: {
          name: "write_to_file",
          args: { TargetFile: "src/unbound-child.js" },
        },
        result: { status: "SUCCESS" },
      }),
      encoding: "utf8",
    });

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf8"));
    assert.equal(state.orchestratorWorkspaceWrites || 0, 0);
    assert.equal(state.unknownWorkspaceWrites, 1);
    assert.ok(state.mutations.some((m) =>
      Array.isArray(m.paths) &&
      m.paths.includes("src/unbound-child.js") &&
      m.authorRole === "UNKNOWN" &&
      m.confidence === "LOW"
    ));
  } finally {
    cleanState();
  }
});


test("governance: normal worker child Stop binds from authoritative parent brain", () => {
  cleanState();
  const brainBaseDir = resolve("scratch/normal-child-stop-brain");
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "normal-stop-parent",
      state: "DELEGATED",
      taskAction: "IMPLEMENT",
    }, null, 2), "utf8");
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
      mainConversationId: "normal-stop-parent",
      bindings: {
        "normal-stop-parent": {
          conversationId: "normal-stop-parent",
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          confidence: "HIGH",
          source: "CONVERSATION_BOUND_IDENTITY",
        },
      },
      conversations: {},
      pendingSubagents: [{
        seq: 1,
        parentConversationId: "normal-stop-parent",
        profile: "flash-low-worker",
        role: "WORKER",
        model: "gemini-3.8-flash-low",
        originToolCallId: "normal-stop-dispatch",
        originStepIdx: 4,
        delegationKind: "WORK",
        consumed: false,
      }],
    }, null, 2), "utf8");

    const subagentsDir = resolve(brainBaseDir, "normal-stop-parent/.system_generated/subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(resolve(subagentsDir, "normal-stop-child.json"), JSON.stringify({
      conversationId: "normal-stop-child",
      subagentDescriptor: {
        typeName: "flash-low-worker",
        role: "Worker",
      },
      spawnStepIndex: 4,
    }, null, 2), "utf8");

    const output = JSON.parse(execFileSync("node", [stopScript], {
      input: JSON.stringify({
        conversationId: "normal-stop-child",
        fullyIdle: true,
        terminationReason: "end_turn",
      }),
      encoding: "utf8",
      env: { ...process.env, AGY_BRAIN_DIR: brainBaseDir },
    }));
    assert.equal(output.decision, "stop");

    const bindings = JSON.parse(readFileSync(".agents/state/role-bindings.json", "utf8"));
    const child = bindings.bindings["normal-stop-child"];
    assert.ok(child, "Child Stop must be able to bind from parent brain without an earlier child tool call");
    assert.equal(child.role, "WORKER");
    assert.equal(child.source, "RUNTIME_IDENTITY");
    assert.equal(child.confidence, "HIGH");
    assert.equal(child.parentConversationId, "normal-stop-parent");
    assert.equal(bindings.pendingSubagents[0].consumed, true);
  } finally {
    cleanState();
  }
});


test("governance: scope checks canonicalize dot-dot traversal before native writes", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER", mutationSeq: 1 }));
    const workerConv = seedFactualWorkerIdentity("traversal-native-worker");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["src/**"],
      forbiddenPaths: [],
    }));

    const controlPlaneTraversal = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolCall: {
          name: "write_to_file",
          args: {
            TargetFile: "src/../.agents/state/pwn.json",
            CodeContent: "{}",
          },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(controlPlaneTraversal.decision, "deny");
    assert.match(controlPlaneTraversal.reason, /CONTROL_PLANE_WRITE_PROHIBITED/);

    const outsideWorkspace = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolCall: {
          name: "write_to_file",
          args: {
            TargetFile: "src/../../outside-workspace.js",
            CodeContent: "bad",
          },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(outsideWorkspace.decision, "deny");
    assert.match(outsideWorkspace.reason, /WORKSPACE_ESCAPE/);
  } finally {
    cleanState();
  }
});

test("governance: scope checks canonicalize dot-dot traversal in worker shell mutations", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER", mutationSeq: 1 }));
    const workerConv = seedFactualWorkerIdentity("traversal-shell-worker");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["src/**"],
      forbiddenPaths: [".agents/**"],
    }));

    const controlPlaneTraversal = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolCall: {
          name: "run_command",
          args: { CommandLine: "touch src/../.agents/state/pwn-shell.json" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(controlPlaneTraversal.decision, "deny");
    assert.match(controlPlaneTraversal.reason, /CONTROL_PLANE_WRITE_PROHIBITED/);

    const outsideWorkspace = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolCall: {
          name: "run_command",
          args: { CommandLine: "touch src/../../outside-shell.js" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(outsideWorkspace.decision, "deny");
    assert.match(outsideWorkspace.reason, /WORKSPACE_ESCAPE/);
  } finally {
    cleanState();
  }
});


test("governance: worker scope follows physical symlink destination", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    mkdirSync("scratch/allowed", { recursive: true });
    symlinkSync(resolve(".agents/state"), resolve("scratch/allowed/control-plane-link"), "dir");

    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER", mutationSeq: 1 }));
    const workerConv = seedFactualWorkerIdentity("symlink-scope-worker");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["scratch/allowed/**"],
      forbiddenPaths: [".agents/**"],
    }));

    const output = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolCall: {
          name: "write_to_file",
          args: {
            TargetFile: "scratch/allowed/control-plane-link/pwn.json",
            CodeContent: "{}",
          },
        },
      }),
      encoding: "utf8",
    }));

    assert.equal(output.decision, "deny");
    assert.match(output.reason, /CONTROL_PLANE_WRITE_PROHIBITED/);
    assert.equal(existsSync(".agents/state/pwn.json"), false);
  } finally {
    cleanState();
  }
});


test("governance: worker can never mutate .agents even when Scope Contract permits it", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER", mutationSeq: 1 }));
    const workerConv = seedFactualWorkerIdentity("control-plane-worker");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: [".agents/**", "src/**"],
      forbiddenPaths: [],
    }));

    const nativeWrite = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolCall: {
          name: "write_to_file",
          args: { TargetFile: ".agents/state/worker-pwn.json", CodeContent: "{}" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(nativeWrite.decision, "deny");
    assert.match(nativeWrite.reason, /CONTROL_PLANE_WRITE_PROHIBITED/);

    const shellWrite = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: workerConv,
        toolCall: {
          name: "run_command",
          args: { CommandLine: "touch .agents/state/worker-pwn-shell.json" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(shellWrite.decision, "deny");
    assert.match(shellWrite.reason, /CONTROL_PLANE_WRITE_PROHIBITED/);
  } finally {
    cleanState();
  }
});

test("governance: AGENTS.md constitution is immutable through shell as well as native writes", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "constitution-orchestrator",
    }));

    const output = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "constitution-orchestrator",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "echo hacked > AGENTS.md" },
        },
      }),
      encoding: "utf8",
    }));
    assert.equal(output.decision, "deny");
    assert.match(output.reason, /AGENTS\.md is the provider-neutral repository constitution/);
  } finally {
    cleanState();
  }
});


test("governance: critical task cannot auto-accept without factual Two-Key review", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "critical-parent",
      state: "EVIDENCE_READY",
      taskAction: "IMPLEMENT",
      criticality: "CRITICAL",
      implementationComplete: true,
      workerCompletionClaimed: true,
      workerValidationObserved: true,
      workerValidationVerified: true,
      workerValidationFresh: true,
      evidenceLedger: [{
        executionId: "critical-evidence",
        command: "node --test test/critical.test.js",
        exitCode: 0,
        mutationSeq: 0,
        actorRole: "WORKER",
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      }],
    }, null, 2), "utf8");
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
      mainConversationId: "critical-parent",
      bindings: {
        "critical-parent": {
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          confidence: "HIGH",
          source: "CONVERSATION_BOUND_IDENTITY",
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2), "utf8");

    const out = JSON.parse(execFileSync("node", [stopScript], {
      input: JSON.stringify({ conversationId: "critical-parent", fullyIdle: true }),
      encoding: "utf8",
    }));
    assert.equal(out.decision, "continue");
    assert.match(out.reason, /TWO_KEY_REVIEW_MISSING|Two-Key|two factual independent reviewer approvals/i);

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf8"));
    assert.notEqual(state.state, "DONE");
    assert.notEqual(state.acceptanceState, "ACCEPTED");
    assert.equal(state.twoKeyReviewGate.required, true);
    assert.equal(state.twoKeyReviewGate.satisfied, false);
  } finally {
    cleanState();
  }
});

test("governance: reviewer batch cardinality is exactly two", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "cardinality-parent",
      state: "ACCEPTANCE",
      taskAction: "REVIEW",
      criticality: "CRITICAL",
    }, null, 2), "utf8");

    const out = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "cardinality-parent",
        toolCall: {
          id: "three-reviewers",
          name: "invoke_subagent",
          args: {
            Subagents: [
              { TypeName: "flash-reviewer", Role: "Reviewer A", Prompt: "Review A" },
              { TypeName: "flash-reviewer", Role: "Reviewer B", Prompt: "Review B" },
              { TypeName: "flash-reviewer", Role: "Reviewer C", Prompt: "Review C" },
            ],
          },
        },
      }),
      encoding: "utf8",
    }));

    assert.equal(out.decision, "deny");
    assert.match(out.reason, /TWO_KEY_REVIEW_CARDINALITY/);
  } finally {
    cleanState();
  }
});

test("governance: two factual reviewer approvals unlock only the exact reviewed candidate", () => {
  cleanState();
  try {
    const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    mkdirSync(".agents/state", { recursive: true });
    const baseState = {
      activeRole: "ORCHESTRATOR",
      conversationId: "two-key-parent",
      state: "EVIDENCE_READY",
      taskAction: "IMPLEMENT",
      criticality: "CRITICAL",
      mutationSeq: 0,
      implementationComplete: true,
      workerCompletionClaimed: true,
      workerValidationObserved: true,
      workerValidationVerified: true,
      workerValidationFresh: true,
      evidenceLedger: [{
        executionId: "two-key-worker-evidence",
        command: "node --test test/critical.test.js",
        exitCode: 0,
        mutationSeq: 0,
        actorRole: "WORKER",
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      }],
      twoKeyReview: {
        status: "EVIDENCE_READY",
        reviewBatchId: "review-batch-1",
        candidateHead,
        candidateMutationSeq: 0,
        expectedReviewerCount: 2,
        reviewerConversationIds: ["reviewer-a", "reviewer-b"],
        reviews: {
          "reviewer-a": {
            conversationId: "reviewer-a",
            verdict: "ACCEPT",
            reviewBatchId: "review-batch-1",
            candidateHead,
            candidateMutationSeq: 0,
            completionHead: candidateHead,
            completionMutationSeq: 0,
            readOnlyViolation: false,
          },
          "reviewer-b": {
            conversationId: "reviewer-b",
            verdict: "ACCEPT_WITH_NOTES",
            reviewBatchId: "review-batch-1",
            candidateHead,
            candidateMutationSeq: 0,
            completionHead: candidateHead,
            completionMutationSeq: 0,
            readOnlyViolation: false,
          },
        },
      },
    };
    writeFileSync(".agents/state/active-state.json", JSON.stringify(baseState, null, 2), "utf8");
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
      mainConversationId: "two-key-parent",
      bindings: {
        "two-key-parent": {
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          confidence: "HIGH",
          source: "CONVERSATION_BOUND_IDENTITY",
        },
        "reviewer-a": {
          role: "REVIEWER",
          profile: "flash-reviewer",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
          delegationKind: "REVIEW",
        },
        "reviewer-b": {
          role: "REVIEWER",
          profile: "flash-reviewer",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
          delegationKind: "REVIEW",
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2), "utf8");

    const accepted = JSON.parse(execFileSync("node", [stopScript], {
      input: JSON.stringify({ conversationId: "two-key-parent", fullyIdle: true }),
      encoding: "utf8",
    }));
    assert.equal(accepted.decision, "stop");
    let state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf8"));
    assert.equal(state.state, "DONE");
    assert.equal(state.acceptanceState, "ACCEPTED");
    assert.equal(state.twoKeyReviewGate.satisfied, true);
    assert.equal(state.twoKeyReviewConsensus, "ACCEPT_WITH_NOTES");

    // Same approvals cannot authorize a newer mutation.
    const staleState = {
      ...baseState,
      state: "EVIDENCE_READY",
      acceptanceState: "PENDING",
      mutationSeq: 1,
      evidenceLedger: [{
        executionId: "two-key-worker-evidence-new",
        command: "node --test test/critical.test.js",
        exitCode: 0,
        mutationSeq: 1,
        actorRole: "WORKER",
        confidence: "HIGH",
        timestamp: new Date().toISOString(),
      }],
    };
    writeFileSync(".agents/state/active-state.json", JSON.stringify(staleState, null, 2), "utf8");

    const stale = JSON.parse(execFileSync("node", [stopScript], {
      input: JSON.stringify({ conversationId: "two-key-parent", fullyIdle: true }),
      encoding: "utf8",
    }));
    assert.equal(stale.decision, "continue");
    assert.match(stale.reason, /TWO_KEY_REVIEW_STALE|two factual independent reviewer approvals/i);
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf8"));
    assert.notEqual(state.state, "DONE");
    assert.equal(state.twoKeyReviewGate.satisfied, false);
    assert.equal(state.twoKeyReviewGate.reason, "TWO_KEY_REVIEW_STALE");
  } finally {
    cleanState();
  }
});


test("governance: unknown conversation cannot self-promote through invoke_subagent", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "escalation-known-main",
      taskAction: "IMPLEMENT",
    }, null, 2), "utf8");
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
      mainConversationId: "escalation-known-main",
      bindings: {
        "escalation-known-main": {
          conversationId: "escalation-known-main",
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          source: "CONVERSATION_BOUND_IDENTITY",
          confidence: "HIGH",
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2), "utf8");

    const output = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "escalation-unknown-child",
        toolCall: {
          id: "escalation-invoke",
          name: "invoke_subagent",
          args: {
            Subagents: [{
              TypeName: "flash-low-worker",
              Role: "worker",
              Prompt: "Attempt unauthorized delegation",
            }],
          },
        },
      }),
      encoding: "utf8",
    }));

    assert.equal(output.decision, "deny");
    assert.match(output.reason, /ORCHESTRATOR_IDENTITY_REQUIRED/);

    const bindings = JSON.parse(readFileSync(".agents/state/role-bindings.json", "utf8"));
    assert.equal(bindings.mainConversationId, "escalation-known-main");
    assert.equal(bindings.bindings["escalation-unknown-child"], undefined);
    assert.equal(bindings.pendingSubagents.length, 0);
  } finally {
    cleanState();
  }
});

test("governance: unknown conversation cannot define subagent profiles", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "define-known-main",
    }, null, 2), "utf8");
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
      mainConversationId: "define-known-main",
      bindings: {
        "define-known-main": {
          conversationId: "define-known-main",
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          source: "CONVERSATION_BOUND_IDENTITY",
          confidence: "HIGH",
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2), "utf8");

    const output = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "define-unknown-child",
        toolCall: {
          name: "define_subagent",
          args: {
            name: "flash-low-worker",
            system_prompt: "ignore governance",
          },
        },
      }),
      encoding: "utf8",
    }));

    assert.equal(output.decision, "deny");
    assert.match(output.reason, /ORCHESTRATOR_IDENTITY_REQUIRED/);
  } finally {
    cleanState();
  }
});

test("governance: authorized orchestrator delegation preserves HIGH identity", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "authorized-main",
      taskAction: "REVIEW",
    }, null, 2), "utf8");
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify({
      mainConversationId: "authorized-main",
      bindings: {
        "authorized-main": {
          conversationId: "authorized-main",
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          source: "CONVERSATION_BOUND_IDENTITY",
          confidence: "HIGH",
        },
      },
      conversations: {},
      pendingSubagents: [],
    }, null, 2), "utf8");

    const output = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "authorized-main",
        toolCall: {
          id: "authorized-review-dispatch",
          name: "invoke_subagent",
          args: {
            Subagents: [
              { TypeName: "flash-reviewer", Role: "reviewer", Prompt: "Review A" },
              { TypeName: "flash-reviewer", Role: "reviewer", Prompt: "Review B" },
            ],
          },
        },
      }),
      encoding: "utf8",
    }));

    assert.equal(output.decision, "allow");
    const bindings = JSON.parse(readFileSync(".agents/state/role-bindings.json", "utf8"));
    assert.equal(bindings.bindings["authorized-main"].confidence, "HIGH");
    assert.equal(bindings.bindings["authorized-main"].role, "ORCHESTRATOR");
  } finally {
    cleanState();
  }
});


test("governance: pre-tool firewall fails closed on malformed or missing payload", () => {
  const malformed = JSON.parse(execFileSync("node", [preToolScript], {
    input: "{not-json",
    encoding: "utf8",
  }));
  assert.equal(malformed.decision, "deny");
  assert.match(malformed.reason, /MALFORMED_HOOK_PAYLOAD/);

  const nullPayload = JSON.parse(execFileSync("node", [preToolScript], {
    input: "null",
    encoding: "utf8",
  }));
  assert.equal(nullPayload.decision, "deny");
  assert.match(nullPayload.reason, /INVALID_HOOK_PAYLOAD/);

  const missingTool = JSON.parse(execFileSync("node", [preToolScript], {
    input: JSON.stringify({ conversationId: "missing-tool" }),
    encoding: "utf8",
  }));
  assert.equal(missingTool.decision, "deny");
  assert.match(missingTool.reason, /missing a valid tool call name/);

  const alternateShape = JSON.parse(execFileSync("node", [preToolScript], {
    input: JSON.stringify({
      conversationId: "alternate-shape",
      toolName: "view_file",
      toolArgs: { AbsolutePath: resolve("package.json") },
    }),
    encoding: "utf8",
  }));
  assert.equal(alternateShape.decision, "allow", "Supported runtime toolName/toolArgs shape remains compatible");
});


test("governance: reviewer scope contracts cannot overwrite implementation acceptance contract", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    seedFactualOrchestratorIdentity("scope-isolation-parent");

    const implementationContract = {
      contractId: "implementation-contract-stable",
      taskId: "scope-isolation-task",
      targetAgent: "flash-medium-worker",
      delegationKind: "WORK",
      allowedPaths: ["src/**"],
      forbiddenPaths: [".agents/**"],
      testsRequired: ["npm test"],
      createdAt: "2026-09-18T00:00:00.000Z",
    };
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "scope-isolation-parent",
      taskAction: "REVIEW",
      taskId: "scope-isolation-task",
      scopeContract: implementationContract,
      mutationSeq: 4,
    }, null, 2), "utf8");
    writeFileSync(".agents/state/active-contract.json", JSON.stringify(implementationContract, null, 2), "utf8");

    const output = JSON.parse(execFileSync("node", [preToolScript], {
      input: JSON.stringify({
        conversationId: "scope-isolation-parent",
        toolCall: {
          id: "review-contract-isolation",
          name: "invoke_subagent",
          args: {
            Subagents: [
              {
                TypeName: "flash-reviewer",
                Role: "reviewer",
                Prompt: "Review A. allowedPaths: [docs/**] testsRequired: [\"npm run reviewer-only-a\"]",
              },
              {
                TypeName: "flash-reviewer",
                Role: "reviewer",
                Prompt: "Review B. allowedPaths: [test/**] testsRequired: [\"npm run reviewer-only-b\"]",
              },
            ],
          },
        },
      }),
      encoding: "utf8",
    }));

    assert.equal(output.decision, "allow");

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf8"));
    const diskContract = JSON.parse(readFileSync(".agents/state/active-contract.json", "utf8"));
    assert.deepEqual(state.scopeContract, implementationContract);
    assert.deepEqual(diskContract, implementationContract);

    const bindings = JSON.parse(readFileSync(".agents/state/role-bindings.json", "utf8"));
    const reviewPending = bindings.pendingSubagents.filter((p) => p.delegationKind === "REVIEW");
    assert.equal(reviewPending.length, 2);
    assert.deepEqual(reviewPending[0].scopeContract.allowedPaths, ["docs/**"]);
    assert.deepEqual(reviewPending[0].scopeContract.testsRequired, ["npm run reviewer-only-a"]);
    assert.deepEqual(reviewPending[1].scopeContract.allowedPaths, ["test/**"]);
    assert.deepEqual(reviewPending[1].scopeContract.testsRequired, ["npm run reviewer-only-b"]);
  } finally {
    cleanState();
  }
});
