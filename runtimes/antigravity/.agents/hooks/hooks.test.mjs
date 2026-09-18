import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { executeGitOperation } from "./git-operation.mjs";
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

test.after(() => {
  cleanState();
});

test("pre-tool hook: allows legitimate control plane writes", () => {
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
    assert.equal(output.decision, "allow");
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
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      taskDomain: "UI",
      allowedPaths: ["apps/web/**"],
      forbiddenPaths: ["packages/core/**"]
    }));

    // Allowed
    const allowedInput = JSON.stringify({
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("apps/web/src/components/Plot.tsx") }
      }
    });
    assert.equal(JSON.parse(execFileSync("node", [preToolScript], { input: allowedInput })).decision, "allow");

    // Forbidden path
    const forbiddenInput = JSON.stringify({
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
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["packages/core/src/**"],
      forbiddenPaths: ["apps/**"]
    }));

    const input = JSON.stringify({
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
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["packages/core/src/**"],
      forbiddenPaths: []
    }));

    const input = JSON.stringify({
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
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["packages/core/**"],
      forbiddenPaths: ["packages/core/src/dsp.ts"]
    }));

    const input = JSON.stringify({
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

    // Arrow function
    const arrowInput = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: 'node -e "const f = (a, b) => a + b; console.log(f(1, 2))"' }
      }
    });
    const arrowRes = JSON.parse(execFileSync("node", [preToolScript], { input: arrowInput }));
    assert.equal(arrowRes.decision, "allow");

    // Relational comparisons
    const compInput = JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: 'node -e "const elapsed = 10; if (elapsed >= 5 && elapsed <= 20) process.exit(0);"' }
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
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      allowedPaths: ["scratch/**"],
      forbiddenPaths: ["packages/**"]
    }));

    const input = JSON.stringify({
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

    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: fixtureDir, encoding: "utf-8" }).trim();
    const stateDir = resolve(fixtureDir, ".agents/state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(resolve(stateDir, "active-state.json"), JSON.stringify({
      gitTransaction: {
        action: "commit",
        commitCreated: true,
        commitHash: head,
        message: "candidate already committed",
        branch: "main",
        pushSucceeded: false,
      },
    }, null, 2), "utf-8");

    const res = executeGitOperation({
      cwd: nestedDir,
      action: "commit",
      message: "different message that cannot match HEAD fallback",
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

test("pre-tool hook: allows orchestrator control plane writes (.agents/**, scratch/**) but blocks AGENTS.md", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    // Allowed control-plane paths
    const allowed = [
      ".agents/state/active-state.json",
      ".agents/state/active-contract.json",
      ".agents/evidence/ledger.json",
      "scratch/experiment.py",
      "scratch/debug-notes.txt",
    ];

    for (const relPath of allowed) {
      const input = JSON.stringify({
        toolCall: {
          name: "write_to_file",
          args: { TargetFile: resolve(relPath) },
        },
      });
      const output = JSON.parse(execFileSync("node", [preToolScript], { input }));
      assert.equal(output.decision, "allow", `Orchestrator write to ${relPath} should be allowed`);
    }

    // AGENTS.md is strictly protected constitution
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

test("pre-tool hook: tracks subagent invocations and binds child conversation ID to worker role", () => {
  cleanState();
  try {
    // 1. invoke_subagent call records pending subagent
    const invokeInput = JSON.stringify({
      conversationId: "parent-conv-1",
      toolCall: {
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

    // Verify role-bindings.json has pending binding
    const bindingsPath = resolve(".agents/state/role-bindings.json");
    assert.ok(existsSync(bindingsPath), "role-bindings.json must exist after invoke_subagent");
    const bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.ok(bindings.pendingSubagents.length > 0, "pendingSubagents must be populated");
    assert.equal(bindings.pendingSubagents[0].role, "WORKER");

    // 2. Authorize scope contract for worker
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      taskDomain: "CODE",
      allowedPaths: ["src/**"],
    }));

    // 3. Child conversation calls tool -> automatically bound to WORKER and allowed within scope
    const childInput = JSON.stringify({
      conversationId: "child-conv-42",
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("src/formatter.js") },
      },
    });
    const childOutput = JSON.parse(execFileSync("node", [preToolScript], { input: childInput }));
    assert.equal(childOutput.decision, "allow", "Bound worker must be allowed to write product file");

    // Verify bindings now map child-conv-42 to WORKER
    const updatedBindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.equal(updatedBindings.conversations["child-conv-42"].role, "WORKER");
  } finally {
    cleanState();
  }
});

test("pre-tool hook: allows worker to write within scope contract but denies out-of-scope files", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "WORKER" }));
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
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("src/formatter.js") },
      },
    });
    const inScopeOutput = JSON.parse(execFileSync("node", [preToolScript], { input: inScopeInput }));
    assert.equal(inScopeOutput.decision, "allow");

    // Out-of-scope write
    const outOfScopeInput = JSON.stringify({
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

test("pre-tool hook: ORCHESTRATOR writing to control plane .agents/state/foo.json is ALLOWED", () => {
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
    assert.equal(output.decision, "allow");
  } finally {
    cleanState();
  }
});

test("pre-tool hook: two pending subagents are consumed sequentially and cannot be reused", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    // Write scope contract
    writeFileSync(".agents/state/active-contract.json", JSON.stringify({ allowedPaths: ["src/**"] }));

    // Orchestrator invokes two subagents
    const invokeInput = JSON.stringify({
      conversationId: "orch-main",
      toolCall: {
        name: "invoke_subagent",
        args: {
          Subagents: [
            { TypeName: "flash-low-worker", Role: "Worker 1", Model: "flash_lite", Prompt: "Task 1" },
            { TypeName: "flash-worker", Role: "Worker 2", Model: "pro", Prompt: "Task 2" },
          ],
        },
      },
    });
    const invokeOutput = JSON.parse(execFileSync("node", [preToolScript], { input: invokeInput }));
    assert.equal(invokeOutput.decision, "allow");

    const bindingsPath = resolve(".agents/state/role-bindings.json");
    let bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.equal(bindings.pendingSubagents.length, 2);
    assert.equal(bindings.pendingSubagents[0].consumed, false);
    assert.equal(bindings.pendingSubagents[1].consumed, false);

    // Child 1 calls tool with distinguishing profile
    const child1Input = JSON.stringify({
      conversationId: "child-conv-1",
      agentProfile: "flash-low-worker",
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("src/formatter.js") },
      },
    });
    const child1Output = JSON.parse(execFileSync("node", [preToolScript], { input: child1Input }));
    assert.equal(child1Output.decision, "allow");

    bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.equal(bindings.pendingSubagents[0].consumed, true);
    assert.equal(bindings.pendingSubagents[0].consumedBy, "child-conv-1");
    assert.equal(bindings.pendingSubagents[1].consumed, false);
    assert.equal(bindings.bindings["child-conv-1"].profile, "flash-low-worker");

    // Child 2 calls tool with second profile
    const child2Input = JSON.stringify({
      conversationId: "child-conv-2",
      agentProfile: "flash-worker",
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("src/formatter.js") },
      },
    });
    const child2Output = JSON.parse(execFileSync("node", [preToolScript], { input: child2Input }));
    assert.equal(child2Output.decision, "allow");

    bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.equal(bindings.pendingSubagents[1].consumed, true);
    assert.equal(bindings.pendingSubagents[1].consumedBy, "child-conv-2");
    assert.equal(bindings.bindings["child-conv-2"].profile, "flash-worker");

    // Child 3 calls tool -> NO unconsumed pending subagents remain!
    const child3Input = JSON.stringify({
      conversationId: "child-conv-3",
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: resolve("src/formatter.js") },
      },
    });
    const child3Output = JSON.parse(execFileSync("node", [preToolScript], { input: child3Input }));
    assert.equal(child3Output.decision, "deny", "Child 3 cannot bind already consumed pending subagents");
    assert(child3Output.reason.includes("ROLE_IDENTITY_UNRESOLVED"));
  } finally {
    cleanState();
  }
});

test("pre-tool hook: reviewer pending binds REVIEWER role and remains strictly read-only", () => {
  cleanState();
  try {
    mkdirSync(".agents/state", { recursive: true });
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
      toolCall: {
        name: "run_command",
        args: { CommandLine: "node --test test/formatter.test.js" },
      },
    });
    const revBOutput = JSON.parse(execFileSync("node", [preToolScript], { input: revBInput }));
    assert.equal(revBOutput.decision, "deny");
    assert(revBOutput.reason.includes("Reviewer is strictly read-only"));

    // Verify bindings confirm both received REVIEWER role
    const bindingsPath = resolve(".agents/state/role-bindings.json");
    const bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
    assert.equal(bindings.bindings["rev-conv-a"].role, "REVIEWER");
    assert.equal(bindings.bindings["rev-conv-b"].role, "REVIEWER");
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
