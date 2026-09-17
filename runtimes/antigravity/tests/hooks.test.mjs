import "../.agents/hooks/hooks.test.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __testDir = dirname(fileURLToPath(import.meta.url));
const preToolScript = resolve(__testDir, "../.agents/hooks/pre-tool-enforce.mjs");
const postToolScript = resolve(__testDir, "../.agents/hooks/post-tool-telemetry.mjs");

function cleanDreamTestState() {
  try { unlinkSync(".agents/state/active-state.json"); } catch {}
  try { unlinkSync(".agents/state/active-contract.json"); } catch {}
  try { unlinkSync(".agents/state/role-bindings.json"); } catch {}
  try { rmSync(".agents/state/executions", { recursive: true, force: true }); } catch {}
  try { rmSync(".agents/state/dream", { recursive: true, force: true }); } catch {}
  try { rmSync(".agents/telemetry/events.jsonl", { recursive: true, force: true }); } catch {}
  try { rmSync("scratch", { recursive: true, force: true }); } catch {}
}

test("Task 5 pre-tool: existing invoke_subagent allow fixtures return byte-compatible decision without unexpected fields", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
    }));

    const input = JSON.stringify({
      conversationId: "task5-orch-conv-1",
      stepIdx: 1,
      toolCall: {
        id: "call_invoke_1",
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              TypeName: "flash-medium-worker",
              Role: "worker",
              Prompt: "Implement feature X in src/foo.ts. allowedPaths: [src/**]",
            }
          ]
        }
      }
    });

    const rawOutput = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
    const output = JSON.parse(rawOutput.trim());
    assert.equal(output.decision, "allow");
    assert.equal(output.overwrite, undefined, "No unexpected overwrite field");
    assert.equal(output.reason, undefined, "No reason field on allow");
  } finally {
    cleanDreamTestState();
  }
});

test("Task 5 pre-tool: allowed worker delegation records pre-action DECISION event with STATIC_POLICY_V1", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
    }));

    const input = JSON.stringify({
      conversationId: "task5-orch-conv-2",
      stepIdx: 2,
      toolCall: {
        id: "call_invoke_2",
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              TypeName: "flash-medium-worker",
              Role: "worker",
              Prompt: "Implement feature Y in src/bar.ts. allowedPaths: [src/**]",
            }
          ]
        }
      }
    });

    const rawOutput = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
    const output = JSON.parse(rawOutput.trim());
    assert.equal(output.decision, "allow");

    // Must record DECISION event in telemetry
    assert(existsSync(".agents/telemetry/events.jsonl"), "events.jsonl must exist");
    const lines = readFileSync(".agents/telemetry/events.jsonl", "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));

    const decEvents = lines.filter(e => e.type === "DECISION");
    assert.equal(decEvents.length, 1, "Must have exactly 1 DECISION event recorded");
    const dec = decEvents[0];
    assert.equal(dec.schema, "orchestra.decision.v1");
    assert.equal(dec.policy_source, "STATIC_POLICY_V1");
    assert.ok(dec.policy_id && dec.policy_id.startsWith("policy-"), "policy_id must be content-addressed");
    assert.equal(dec.decision_type, "WORKER_TIER");
    assert.equal(dec.chosen_action, "FLASH_MEDIUM");
    assert(Array.isArray(dec.available_actions));
    assert(dec.available_actions.includes("FLASH_MEDIUM"));
    assert(dec.snapshot_id && dec.snapshot_id.startsWith("sha256:"));
    assert(dec.event_hash && dec.event_hash.startsWith("sha256:"));

    // Check pending decision correlation file
    const pendingDir = resolve(".agents/state/dream/pending-decisions");
    assert(existsSync(pendingDir), "pending-decisions dir must exist");
  } finally {
    cleanDreamTestState();
  }
});

test("Task 5 pre-tool: fallback to STATIC_ROUTING_FALLBACK when policy corrupted or mismatched", () => {
  cleanDreamTestState();
  const policyBackupPath = resolve(__testDir, "../.agents/dream/policies/static-policy-v1.json");
  let originalPolicy = null;
  if (existsSync(policyBackupPath)) {
    originalPolicy = readFileSync(policyBackupPath, "utf-8");
  }
  try {
    // Write corrupted policy
    writeFileSync(policyBackupPath, JSON.stringify({ schema: "corrupted" }), "utf-8");

    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
    }));

    const input = JSON.stringify({
      conversationId: "task5-fallback-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_invoke_fallback",
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              TypeName: "flash-medium-worker",
              Role: "worker",
              Prompt: "Implement feature in src/fallback.ts. allowedPaths: [src/**]",
            }
          ]
        }
      }
    });

    const rawOutput = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
    const output = JSON.parse(rawOutput.trim());
    assert.equal(output.decision, "allow");

    const lines = readFileSync(".agents/telemetry/events.jsonl", "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));

    const decEvents = lines.filter(e => e.type === "DECISION");
    assert.equal(decEvents.length, 1);
    const dec = decEvents[0];
    assert.equal(dec.policy_source, "STATIC_ROUTING_FALLBACK");
    assert.equal(dec.chosen_action, "FLASH_MEDIUM");
  } finally {
    if (originalPolicy !== null) {
      writeFileSync(policyBackupPath, originalPolicy, "utf-8");
    }
    cleanDreamTestState();
  }
});

test("Task 5 post-tool: post-tool execution records matching DECISION_OUTCOME", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
    }));

    const toolCall = {
      id: "call_invoke_post_1",
      name: "invoke_subagent",
      args: {
        Subagents: [
          {
            TypeName: "flash-medium-worker",
            Role: "worker",
            Prompt: "Implement feature Z in src/baz.ts. allowedPaths: [src/**]",
          }
        ]
      }
    };

    // 1. Run pre-tool hook to generate pre-action DECISION
    const preInput = JSON.stringify({
      conversationId: "task5-orch-conv-post",
      stepIdx: 5,
      toolCall,
    });
    const preOutput = JSON.parse(execFileSync("node", [preToolScript], { input: preInput, encoding: "utf-8" }).trim());
    assert.equal(preOutput.decision, "allow");

    // Read recorded DECISION
    const preLines = readFileSync(".agents/telemetry/events.jsonl", "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const decEvent = preLines.find(e => e.type === "DECISION");
    assert(decEvent, "DECISION event must exist");

    // 2. Run post-tool hook to observe completion and record DECISION_OUTCOME
    const postInput = JSON.stringify({
      conversationId: "task5-orch-conv-post",
      stepIdx: 5,
      toolName: "invoke_subagent",
      toolCall,
      toolResult: "SUCCESS",
    });
    const postOutput = JSON.parse(execFileSync("node", [postToolScript], { input: postInput, encoding: "utf-8" }).trim());
    assert.deepEqual(postOutput, {});

    // Read recorded DECISION_OUTCOME
    const postLines = readFileSync(".agents/telemetry/events.jsonl", "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const outcomeEvents = postLines.filter(e => e.type === "DECISION_OUTCOME");
    assert.equal(outcomeEvents.length, 1, "Must record exactly 1 DECISION_OUTCOME event");
    const outcome = outcomeEvents[0];
    assert.equal(outcome.schema, "orchestra.outcome.v1");
    assert.equal(outcome.decision_id, decEvent.decision_id);
    assert.equal(outcome.result, "SUCCESS");
    assert(outcome.evidence_summary && typeof outcome.evidence_summary === "object");
    assert(outcome.retry_state && typeof outcome.retry_state === "object");
    assert(outcome.cost_metrics && typeof outcome.cost_metrics === "object");
    assert(outcome.observation_id && outcome.observation_id.startsWith("obs-"));
    assert(outcome.event_hash && outcome.event_hash.startsWith("sha256:"));

    // Check that pending decision file was consumed
    const pendingDir = resolve(".agents/state/dream/pending-decisions");
    const pendingFiles = readdirSync(pendingDir).filter(f => f.endsWith(".json"));
    assert.equal(pendingFiles.length, 0, "Pending decision file must be consumed");
  } finally {
    cleanDreamTestState();
  }
});

test("Task 5 pre-tool: Direct Action and CRITICAL review paths do NOT record DECISION events", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });

    // Scenario A: Direct Action blocks subagent invocation and records no DECISION
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "DIRECT_ACTION",
      isDirectAction: true,
    }));

    const directActionInput = JSON.stringify({
      conversationId: "task5-da-conv",
      stepIdx: 1,
      toolCall: {
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-worker", Role: "worker", Prompt: "work" }]
        }
      }
    });
    const daOutput = JSON.parse(execFileSync("node", [preToolScript], { input: directActionInput, encoding: "utf-8" }).trim());
    assert.equal(daOutput.decision, "deny");
    assert(!existsSync(".agents/telemetry/events.jsonl") || readFileSync(".agents/telemetry/events.jsonl", "utf-8").trim() === "");

    cleanDreamTestState();

    // Scenario B: CRITICAL task delegates to reviewer pair -> NO DECISION recorded
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      criticality: "CRITICAL",
      taskAction: "REVIEW",
    }));

    const criticalInput = JSON.stringify({
      conversationId: "task5-crit-conv",
      stepIdx: 2,
      toolCall: {
        name: "invoke_subagent",
        args: {
          Subagents: [
            { TypeName: "flash-reviewer", Role: "reviewer", Prompt: "Review critical patch" },
            { TypeName: "flash-reviewer", Role: "reviewer", Prompt: "Review critical patch 2" },
          ]
        }
      }
    });
    const critOutput = JSON.parse(execFileSync("node", [preToolScript], { input: criticalInput, encoding: "utf-8" }).trim());
    assert.equal(critOutput.decision, "allow");

    // Assert NO DECISION events were recorded for CRITICAL review
    if (existsSync(".agents/telemetry/events.jsonl")) {
      const critLines = readFileSync(".agents/telemetry/events.jsonl", "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line));
      const critDecs = critLines.filter(e => e.type === "DECISION");
      assert.equal(critDecs.length, 0, "No DECISION event for CRITICAL review");
    }

    cleanDreamTestState();

    // Scenario C: Non-critical Reviewer delegation -> NO DECISION recorded
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      criticality: "NORMAL",
      taskAction: "REVIEW",
    }));

    const reviewerInput = JSON.stringify({
      conversationId: "task5-rev-conv",
      stepIdx: 3,
      toolCall: {
        name: "invoke_subagent",
        args: {
          Subagents: [
            { TypeName: "flash-reviewer", Role: "reviewer", Prompt: "Review normal patch" }
          ]
        }
      }
    });
    const revOutput = JSON.parse(execFileSync("node", [preToolScript], { input: reviewerInput, encoding: "utf-8" }).trim());
    assert.equal(revOutput.decision, "allow");

    if (existsSync(".agents/telemetry/events.jsonl")) {
      const revLines = readFileSync(".agents/telemetry/events.jsonl", "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line));
      const revDecs = revLines.filter(e => e.type === "DECISION");
      assert.equal(revDecs.length, 0, "No DECISION event for reviewer delegation");
    }
  } finally {
    cleanDreamTestState();
  }
});

test("Task 5 pre-tool: unwritable telemetry fails open and still returns decision: allow", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
    }));

    // Create telemetry path as a directory so file append throws
    mkdirSync(".agents/telemetry/events.jsonl", { recursive: true });

    const input = JSON.stringify({
      conversationId: "task5-unwritable-conv",
      stepIdx: 10,
      toolCall: {
        id: "call_invoke_failopen",
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              TypeName: "flash-medium-worker",
              Role: "worker",
              Prompt: "Implement feature W. allowedPaths: [src/**]",
            }
          ]
        }
      }
    });

    const rawOutput = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
    const output = JSON.parse(rawOutput.trim());

    // Primary task must NOT fail: hook still returns allow!
    assert.equal(output.decision, "allow");
    assert.equal(output.overwrite, undefined);

    // Compact diagnostic recorded in activeState
    const stateContent = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert(stateContent.dreamRecordingError, "dreamRecordingError must be recorded in activeState");
  } finally {
    cleanDreamTestState();
  }
});
