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
const postToolScript = resolve(runtimeRoot, ".agents/hooks/post-tool-telemetry.mjs");
const stopScript = resolve(runtimeRoot, ".agents/hooks/stop-guard.mjs");

function cleanState() {
  process.chdir(runtimeRoot);
  try { unlinkSync(".agents/state/active-state.json"); } catch {}
  try { unlinkSync(".agents/state/active-contract.json"); } catch {}
  try { rmSync(".agents/state/executions", { recursive: true, force: true }); } catch {}
  try { unlinkSync(".agents/telemetry/events.jsonl"); } catch {}
}

test.beforeEach(() => {
  cleanState();
});

test.after(() => {
  cleanState();
});

test("instrumentation: pre-invocation-guard counts invocations and records advisories", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    benchmarkRunId: "test-run-1",
    taskId: "status",
    loopSuspected: true,
    coordinationOverheadDetected: true,
  }));

  const input = JSON.stringify({
    invocationNum: 1,
    conversationId: "test-conv-100",
  });

  const output = JSON.parse(execFileSync("node", [preInvocationScript], { input }));
  assert(output.injectSteps.length >= 2);

  // Check state update
  const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(state.preinvocation_count, 1);
  assert.equal(state.model_invocations, 1);
  assert.equal(state.advisory_injections_total, 2);
  assert.equal(state.advisory_injections_by_type.LOOP_SUSPECTED, 1);
  assert.equal(state.advisory_injections_by_type.COORDINATION_OVERHEAD, 1);
  assert(state.context_proxy_bytes > 0);

  // Check telemetry event
  assert(existsSync(".agents/telemetry/events.jsonl"));
  const lines = readFileSync(".agents/telemetry/events.jsonl", "utf-8").trim().split("\n");
  const event = JSON.parse(lines[lines.length - 1]);
  assert.equal(event.type, "PRE_INVOCATION");
  assert.equal(event.benchmarkRunId, "test-run-1");
  assert.equal(event.taskId, "status");
  assert.equal(event.preinvocation_count, 1);
});

test("instrumentation: stop-guard distinguishes clean stops vs forced continuations", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    benchmarkRunId: "test-run-2",
    taskId: "simple-impl",
    claimCompleted: true,
    acceptanceState: "PENDING",
    taskAction: "IMPLEMENTATION",
  }));

  // First stop attempt -> blocked because claimed without acceptance
  const out1 = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
  assert.equal(out1.decision, "continue");

  let state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(state.stop_attempts, 1);
  assert.equal(state.forced_stop_continuations, 1);
  assert.equal(state.forced_continuations_by_reason.CLAIMED_WITHOUT_ACCEPTANCE, 1);

  // Now simulate acceptance satisfied
  state.acceptanceState = "ACCEPTED";
  state.state = "DONE";
  writeFileSync(".agents/state/active-state.json", JSON.stringify(state));

  const out2 = JSON.parse(execFileSync("node", [stopScript], { input: "{}" }));
  assert.equal(out2.decision, "stop");

  state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(state.stop_attempts, 2);
  assert.equal(state.forced_stop_continuations, 1);
  assert.equal(state.clean_stops, 1);
});

test("instrumentation: post-tool-telemetry records tool turn metrics, subagents and packet sizes", () => {
  cleanState();
  mkdirSync(".agents/state", { recursive: true });
  writeFileSync(".agents/state/active-state.json", JSON.stringify({
    benchmarkRunId: "test-run-3",
    taskId: "multi-file",
  }));

  // 1. Native read tool
  execFileSync("node", [postToolScript], {
    input: JSON.stringify({
      toolName: "view_file",
      toolCall: { name: "view_file", args: { StartLine: 1, EndLine: 50 } },
    }),
  });

  // 2. Native search tool
  execFileSync("node", [postToolScript], {
    input: JSON.stringify({
      toolName: "grep_search",
      toolCall: { name: "grep_search", args: { Query: "calc" } },
    }),
  });

  // 3. Subagent invocation (worker)
  execFileSync("node", [postToolScript], {
    input: JSON.stringify({
      toolName: "invoke_subagent",
      toolCall: {
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-worker", Role: "Worker", Prompt: "Implement precision option" }],
        },
      },
    }),
  });

  // 4. Subagent invocation (reviewer)
  execFileSync("node", [postToolScript], {
    input: JSON.stringify({
      toolName: "invoke_subagent",
      toolCall: {
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-reviewer", Role: "Two-Key Reviewer 1", Prompt: "Review diff" }],
        },
      },
    }),
  });

  // 5. Mutation tool
  execFileSync("node", [postToolScript], {
    input: JSON.stringify({
      toolName: "replace_file_content",
      toolCall: { name: "replace_file_content", args: { TargetFile: "src/formatter.js" } },
    }),
  });

  // 6. Verification tool after mutation
  execFileSync("node", [postToolScript], {
    input: JSON.stringify({
      toolName: "run_command",
      toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
    }),
  });

  const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
  assert.equal(state.tool_calls_total, 6);
  assert.equal(state.native_tool_calls, 3); // view_file, grep_search, replace_file_content
  assert.equal(state.run_command_calls, 1);
  assert.equal(state.read_tool_calls, 2); // view_file, grep_search
  assert.equal(state.write_tool_calls, 1); // replace_file_content
  assert.equal(state.verification_tool_calls, 1); // run_command npm test
  assert.equal(state.tools_before_first_mutation, 4); // view_file, grep_search, invoke worker, invoke reviewer
  assert.equal(state.tools_after_last_mutation, 1); // verification run_command
  assert.equal(state.invoke_subagent_calls, 2);
  assert.equal(state.worker_invocations, 1);
  assert.equal(state.reviewer_invocations, 1);
  assert(state.worker_packet_bytes > 0);
  assert(state.review_packet_bytes > 0);
  assert(state.context_proxy_bytes > 0);
});
