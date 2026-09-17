import "../.agents/hooks/hooks.test.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computePolicyId, validatePolicy } from "../.agents/dream/policy-engine.mjs";
import { executeReplanTransition } from "../.agents/hooks/pre-tool-enforce.mjs";

const __testDir = dirname(fileURLToPath(import.meta.url));
const preToolScript = resolve(__testDir, "../.agents/hooks/pre-tool-enforce.mjs");
const postToolScript = resolve(__testDir, "../.agents/hooks/post-tool-telemetry.mjs");
const stopToolScript = resolve(__testDir, "../.agents/hooks/stop-guard.mjs");

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

test("Task 2: online policy authority denies mismatched worker delegation and forbids false DECISION recording", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
      criticality: "NORMAL",
    }, null, 2), "utf-8");

    // Requested worker is flash-worker (FLASH_HIGH), but policy selects FLASH_MEDIUM
    const input = JSON.stringify({
      conversationId: "task2-mismatch-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_mismatch_1",
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              TypeName: "flash-worker",
              Role: "worker",
              Prompt: "Implement feature X in src/foo.ts. allowedPaths: [src/**]",
            }
          ]
        }
      }
    });

    const rawOutput = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
    const output = JSON.parse(rawOutput.trim());

    // Must be DENIED before execution
    assert.equal(output.decision, "deny", "Mismatched worker delegation must be denied");
    assert.match(output.reason, /POLICY_MISMATCH/i, "Reason must indicate policy mismatch");
    assert.match(output.reason, /FLASH_MEDIUM/i, "Reason must inform expected deterministic action");

    // Invariant: no false DECISION record may be created
    const recordsPath = ".agents/telemetry/events.jsonl";
    if (existsSync(recordsPath)) {
      const records = readFileSync(recordsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const decisionEvents = records.filter(r => r.type === "DECISION");
      assert.equal(decisionEvents.length, 0, "No DECISION event should be recorded on denied delegation");
    }

    // Role bindings must not register the denied subagent
    const roleBindingsPath = ".agents/state/role-bindings.json";
    if (existsSync(roleBindingsPath)) {
      const bindings = JSON.parse(readFileSync(roleBindingsPath, "utf-8"));
      assert.equal(bindings.pendingSubagents?.length ?? 0, 0, "Denied subagent must not be in pendingSubagents");
    }
  } finally {
    cleanDreamTestState();
  }
});

test("Task 2: execution identity invariant (policy selected action == accepted execution identity == recorded chosen_action)", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
      criticality: "NORMAL",
    }, null, 2), "utf-8");

    // Requested worker matches policy expectation (flash-medium-worker)
    const input = JSON.stringify({
      conversationId: "task2-match-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_match_1",
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

    // Verify DECISION record
    const recordsPath = ".agents/telemetry/events.jsonl";
    assert.ok(existsSync(recordsPath), "events.jsonl must exist");
    const records = readFileSync(recordsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const dec = records.find(r => r.type === "DECISION");
    assert.ok(dec, "DECISION event must be recorded");

    // Execution identity assertions
    const policySelectedAction = "FLASH_MEDIUM";
    const acceptedExecutionIdentity = "flash-medium-worker";
    assert.equal(dec.chosen_action, policySelectedAction, "recorded chosen_action must match policy action");
    assert.equal(dec.chosen_action, "FLASH_MEDIUM");

    // Role bindings check
    const roleBindingsPath = ".agents/state/role-bindings.json";
    const bindings = JSON.parse(readFileSync(roleBindingsPath, "utf-8"));
    const pending = bindings.pendingSubagents?.[0];
    assert.ok(pending, "pendingSubagents must have registered worker");
    assert.equal(pending.profile, acceptedExecutionIdentity, "Registered profile must match accepted execution identity");
  } finally {
    cleanDreamTestState();
  }
});

test("Task 3: INVESTIGATION_STRATEGY congruence (IMPLEMENT_DIRECT allows and records factual DECISION)", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "WORKER",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
      criticality: "NORMAL",
      mutationSeq: 0,
      postInvestigation: false,
    }, null, 2), "utf-8");

    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      contractId: "contract-inv-direct",
      allowedPaths: ["src/**"],
      forbiddenPaths: [".agents/**"],
      testsRequired: ["npm test"],
    }, null, 2), "utf-8");

    // Worker attempts first write to product code
    const input = JSON.stringify({
      conversationId: "task3-inv-direct-conv",
      stepIdx: 2,
      toolCall: {
        id: "call_write_direct",
        name: "write_to_file",
        args: {
          TargetFile: "src/feature.ts",
          CodeContent: "export const x = 1;",
          Description: "implement feature",
        }
      }
    });

    const rawOutput = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
    const output = JSON.parse(rawOutput.trim());

    assert.equal(output.decision, "allow");

    // Check that INVESTIGATION_STRATEGY DECISION was factually recorded pre-action
    const eventsPath = ".agents/telemetry/events.jsonl";
    assert.ok(existsSync(eventsPath));
    const events = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const invDecision = events.find(e => e.type === "DECISION" && e.decision_type === "INVESTIGATION_STRATEGY");
    assert.ok(invDecision, "INVESTIGATION_STRATEGY decision must be recorded");
    assert.equal(invDecision.chosen_action, "IMPLEMENT_DIRECT");
  } finally {
    cleanDreamTestState();
  }
});

test("Task 3: INVESTIGATION_STRATEGY blocked mismatch (INVESTIGATE_FIRST blocks worker mutation)", () => {
  cleanDreamTestState();
  const policyBackupPath = resolve(__testDir, "../.agents/dream/policies/static-policy-v1.json");
  let originalPolicy = null;
  if (existsSync(policyBackupPath)) {
    originalPolicy = readFileSync(policyBackupPath, "utf-8");
  }

  try {
    // Temporarily insert high-priority INVESTIGATE_FIRST rule
    const parsed = JSON.parse(originalPolicy);
    parsed.rules.unshift({
      id: "force-investigate-first",
      decision_type: "INVESTIGATION_STRATEGY",
      priority: 150,
      when: { task_action: ["IMPLEMENT"] },
      choose: "INVESTIGATE_FIRST",
      description: "Force investigation first for test",
    });
    parsed.policy_id = computePolicyId(parsed);
    writeFileSync(policyBackupPath, JSON.stringify(parsed, null, 2), "utf-8");

    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "WORKER",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
      criticality: "NORMAL",
      mutationSeq: 0,
      postInvestigation: false,
    }, null, 2), "utf-8");

    writeFileSync(".agents/state/active-contract.json", JSON.stringify({
      contractId: "contract-inv-gate",
      allowedPaths: ["src/**"],
      forbiddenPaths: [".agents/**"],
      testsRequired: ["npm test"],
    }, null, 2), "utf-8");

    const input = JSON.stringify({
      conversationId: "task3-inv-block-conv",
      stepIdx: 2,
      toolCall: {
        id: "call_write_blocked",
        name: "write_to_file",
        args: {
          TargetFile: "src/feature.ts",
          CodeContent: "export const x = 1;",
          Description: "implement feature",
        }
      }
    });

    const rawOutput = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
    const output = JSON.parse(rawOutput.trim());

    // Deterministic denial gate trips
    assert.equal(output.decision, "deny");
    assert.match(output.reason, /INVESTIGATION_REQUIRED/i);

    // No DECISION record created on denial
    const eventsPath = ".agents/telemetry/events.jsonl";
    if (existsSync(eventsPath)) {
      const events = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const invDec = events.find(e => e.type === "DECISION" && e.decision_type === "INVESTIGATION_STRATEGY");
      assert.equal(invDec, undefined);
    }
  } finally {
    if (originalPolicy !== null) {
      writeFileSync(policyBackupPath, originalPolicy, "utf-8");
    }
    cleanDreamTestState();
  }
});

test("Task 3: RETRY_ACTION semantics (congruence allows, mismatch and budget inflation blocked)", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
      criticality: "NORMAL",
      retry: true,
      attempt: 1,
      remainingAttempts: 1,
      prevRemainingAttempts: 1,
      retryReason: "FAILED_TEST",
      lastWorkerProfile: "flash-medium-worker",
    }, null, 2), "utf-8");

    // Case A: Congruent retry (RETRY_SAME with same worker) -> ALLOW
    const inputMatch = JSON.stringify({
      conversationId: "task3-retry-conv",
      stepIdx: 5,
      toolCall: {
        id: "call_retry_match",
        name: "invoke_subagent",
        args: {
          remainingAttempts: 1,
          Subagents: [
            {
              TypeName: "flash-medium-worker",
              Role: "worker",
              Prompt: "Retry fix for failed test. allowedPaths: [src/**]",
            }
          ]
        }
      }
    });

    const rawOutputMatch = execFileSync("node", [preToolScript], { input: inputMatch, encoding: "utf-8" });
    const outputMatch = JSON.parse(rawOutputMatch.trim());
    assert.equal(outputMatch.decision, "allow");

    const eventsPath = ".agents/telemetry/events.jsonl";
    assert.ok(existsSync(eventsPath));
    const events = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const retryDec = events.find(e => e.type === "DECISION" && e.decision_type === "RETRY_ACTION");
    assert.ok(retryDec, "RETRY_ACTION decision must be recorded");
    assert.equal(retryDec.chosen_action, "RETRY_SAME");

    // Case B: Retry budget inflation attempted -> DENY
    const inputInflation = JSON.stringify({
      conversationId: "task3-retry-conv",
      stepIdx: 6,
      toolCall: {
        id: "call_retry_inflate",
        name: "invoke_subagent",
        args: {
          remainingAttempts: 5, // inflated!
          Subagents: [
            {
              TypeName: "flash-medium-worker",
              Role: "worker",
              Prompt: "Retry fix with inflated budget. allowedPaths: [src/**]",
            }
          ]
        }
      }
    });

    const rawOutputInflate = execFileSync("node", [preToolScript], { input: inputInflation, encoding: "utf-8" });
    const outputInflate = JSON.parse(rawOutputInflate.trim());
    assert.equal(outputInflate.decision, "deny");
    assert.match(outputInflate.reason, /RETRY_BUDGET_VIOLATION/i);

    // Case C: Mismatched escalation on RETRY_SAME -> DENY
    const inputEscalate = JSON.stringify({
      conversationId: "task3-retry-conv",
      stepIdx: 7,
      toolCall: {
        id: "call_retry_escalate",
        name: "invoke_subagent",
        args: {
          remainingAttempts: 1,
          Subagents: [
            {
              TypeName: "flash-worker", // escalated when policy wants RETRY_SAME
              Role: "worker",
              Prompt: "Retry fix with unauthorized escalation. allowedPaths: [src/**]",
            }
          ]
        }
      }
    });

    const rawOutputEscalate = execFileSync("node", [preToolScript], { input: inputEscalate, encoding: "utf-8" });
    const outputEscalate = JSON.parse(rawOutputEscalate.trim());
    assert.equal(outputEscalate.decision, "deny");
    assert.match(outputEscalate.reason, /POLICY_MISMATCH/i);
  } finally {
    cleanDreamTestState();
  }
});

test("Task 5: Self-host isolation (hook resolves active image policy, ignoring candidate repo source)", () => {
  cleanDreamTestState();
  const fakeRepoDir = resolve(".agents/scratch/fake-repo-candidate");
  try {
    mkdirSync(resolve(fakeRepoDir, "runtimes/antigravity/.agents/dream/policies"), { recursive: true });
    // Write corrupted/mismatched candidate policy into fakeRepoDir
    writeFileSync(
      resolve(fakeRepoDir, "runtimes/antigravity/.agents/dream/policies/static-policy-v1.json"),
      JSON.stringify({ schema: "corrupted-candidate-policy" }),
      "utf-8"
    );

    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
      criticality: "NORMAL",
    }, null, 2), "utf-8");

    const input = JSON.stringify({
      conversationId: "task5-isolation-conv",
      repoRoot: fakeRepoDir, // Pass candidate repoRoot containing corrupted candidate policy
      stepIdx: 1,
      toolCall: {
        id: "call_isolation_1",
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              TypeName: "flash-medium-worker",
              Role: "worker",
              Prompt: "Implement feature in isolated repo. allowedPaths: [src/**]",
            }
          ]
        }
      }
    });

    const rawOutput = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
    const output = JSON.parse(rawOutput.trim());

    // Hook must succeed using active runtime image policy
    assert.equal(output.decision, "allow");

    const eventsPath = ".agents/telemetry/events.jsonl";
    assert.ok(existsSync(eventsPath));
    const events = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const dec = events.find(e => e.type === "DECISION");
    assert.ok(dec);
    assert.equal(dec.policy_source, "STATIC_POLICY_V1", "Must load STATIC_POLICY_V1 from active image, NOT corrupted candidate source");
  } finally {
    cleanDreamTestState();
  }
});

test("Task 1 Action Leakage RED test: different requested worker profiles must produce same Decision State, same baseline, same policy action", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    // State without explicit complexity: router default semantics must apply (NORMAL), not requested profile
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
    }, null, 2), "utf-8");

    // Profile 1: flash-low-worker
    const inputLow = JSON.stringify({
      conversationId: "task1-leakage-conv-low",
      stepIdx: 1,
      toolCall: {
        id: "call_leakage_low",
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-low-worker", Role: "worker", Prompt: "Implement feature" }]
        }
      }
    });

    const rawLow = execFileSync("node", [preToolScript], { input: inputLow, encoding: "utf-8" });
    const resLow = JSON.parse(rawLow.trim());

    // Profile 2: flash-worker (FLASH_HIGH)
    const inputHigh = JSON.stringify({
      conversationId: "task1-leakage-conv-high",
      stepIdx: 1,
      toolCall: {
        id: "call_leakage_high",
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-worker", Role: "worker", Prompt: "Implement feature" }]
        }
      }
    });

    const rawHigh = execFileSync("node", [preToolScript], { input: inputHigh, encoding: "utf-8" });
    const resHigh = JSON.parse(rawHigh.trim());

    // Both should be evaluated against the true baseline (FLASH_MEDIUM) and policy (FLASH_MEDIUM).
    // Therefore, flash-low-worker and flash-worker should be DENIED as POLICY_MISMATCH,
    // and must NOT alter the baseline or policy choice to match their own profile!
    assert.equal(resLow.decision, "deny", "flash-low-worker must be denied for normal implementation");
    assert.match(resLow.reason, /POLICY_MISMATCH.*FLASH_MEDIUM/);

    assert.equal(resHigh.decision, "deny", "flash-worker must be denied for normal implementation");
    assert.match(resHigh.reason, /POLICY_MISMATCH.*FLASH_MEDIUM/);

    // Profile 3: flash-medium-worker (matching profile) -> ALLOW
    const inputMed = JSON.stringify({
      conversationId: "task1-leakage-conv-med",
      stepIdx: 1,
      toolCall: {
        id: "call_leakage_med",
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-medium-worker", Role: "worker", Prompt: "Implement feature" }]
        }
      }
    });

    const rawMed = execFileSync("node", [preToolScript], { input: inputMed, encoding: "utf-8" });
    const resMed = JSON.parse(rawMed.trim());
    assert.equal(resMed.decision, "allow");

    // Check recorded DECISION event
    const eventsPath = ".agents/telemetry/events.jsonl";
    const events = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const medDec = events.find(e => e.conversation_id === "task1-leakage-conv-med" && e.type === "DECISION");
    assert.ok(medDec);
    assert.equal(medDec.state.complexity, "NORMAL", "Decision state complexity must be NORMAL, not leaked from requested profile");
    assert.equal(medDec.baseline_action, "FLASH_MEDIUM");
    assert.equal(medDec.chosen_action, "FLASH_MEDIUM");
  } finally {
    cleanDreamTestState();
  }
});

test("Task 1 Fallback RED test: normal implementation, requested FLASH_HIGH, real baseline FLASH_MEDIUM, corrupted policy -> deny requested", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
      criticality: "NORMAL",
    }, null, 2), "utf-8");

    // Corrupt the active policy in image temporarily to trigger fallback
    const policyPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.agents/dream/policies/static-policy-v1.json");
    const originalPolicyRaw = readFileSync(policyPath, "utf-8");
    try {
      writeFileSync(policyPath, JSON.stringify({ schema: "corrupted" }), "utf-8");

      // Orchestrator attempts to request flash-worker (FLASH_HIGH)
      const inputHigh = JSON.stringify({
        conversationId: "task1-fallback-conv",
        stepIdx: 1,
        toolCall: {
          id: "call_fallback_high",
          name: "invoke_subagent",
          args: {
            Subagents: [{ TypeName: "flash-worker", Role: "worker", Prompt: "Implement feature" }]
          }
        }
      });

      const rawHigh = execFileSync("node", [preToolScript], { input: inputHigh, encoding: "utf-8" });
      const resHigh = JSON.parse(rawHigh.trim());

      // Under fallback, baseline_action must be FLASH_MEDIUM, chosen_action must be FLASH_MEDIUM,
      // and requested flash-worker MUST NOT EXECUTE (decision must be deny)
      assert.equal(resHigh.decision, "deny", "Requested flash-worker must be denied under fallback");
      assert.match(resHigh.reason, /POLICY_MISMATCH.*FLASH_MEDIUM.*flash-worker/);
    } finally {
      writeFileSync(policyPath, originalPolicyRaw, "utf-8");
    }
  } finally {
    cleanDreamTestState();
  }
});

test("Task 2 Strict RETRY_SAME matrix enforcement (M->M allow, M->H deny, M->L deny, L->M deny, H->M deny, H->H allow)", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });

    const matrix = [
      { last: "flash-medium-worker", req: "flash-medium-worker", expected: "allow" },
      { last: "flash-medium-worker", req: "flash-worker", expected: "deny" },
      { last: "flash-medium-worker", req: "flash-low-worker", expected: "deny" },
      { last: "flash-low-worker", req: "flash-medium-worker", expected: "deny" },
      { last: "flash-worker", req: "flash-medium-worker", expected: "deny" },
      { last: "flash-worker", req: "flash-worker", expected: "allow" },
    ];

    for (const [idx, item] of matrix.entries()) {
      cleanDreamTestState();
      mkdirSync(".agents/state", { recursive: true });
      writeFileSync(".agents/state/active-state.json", JSON.stringify({
        activeRole: "ORCHESTRATOR",
        taskAction: "IMPLEMENT",
        taskDomain: "CODE",
        criticality: "NORMAL",
        retry: true,
        attempt: 1,
        remainingAttempts: 1,
        prevRemainingAttempts: 1,
        retryReason: "FAILED_TEST",
        lastWorkerProfile: item.last,
      }, null, 2), "utf-8");

      const input = JSON.stringify({
        conversationId: `task2-matrix-${idx}`,
        stepIdx: idx + 1,
        toolCall: {
          id: `call_matrix_${idx}`,
          name: "invoke_subagent",
          args: {
            remainingAttempts: 1,
            Subagents: [
              {
                TypeName: item.req,
                Role: "worker",
                Prompt: `Retry fix. allowedPaths: [src/**]`,
              }
            ]
          }
        }
      });

      const raw = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
      const res = JSON.parse(raw.trim());
      assert.equal(res.decision, item.expected, `Matrix ${item.last} -> ${item.req} expected ${item.expected} but got ${res.decision}`);
      if (item.expected === "deny") {
        assert.match(res.reason, /POLICY_MISMATCH.*RETRY_SAME/);
      }
    }
  } finally {
    cleanDreamTestState();
  }
});

test("Task 2 Causal Lifecycle: INVESTIGATION_STRATEGY pending requirement and congruent satisfaction", () => {
  cleanDreamTestState();
  const policyBackupPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.agents/dream/policies/static-policy-v1.json");
  const originalPolicy = readFileSync(policyBackupPath, "utf-8");
  try {
    const parsed = JSON.parse(originalPolicy);
    parsed.rules.unshift({
      id: "force-investigate-first-test",
      decision_type: "INVESTIGATION_STRATEGY",
      priority: 999,
      when: { task_action: ["IMPLEMENT"] },
      choose: "INVESTIGATE_FIRST",
      description: "Force investigation first for causal lifecycle test",
    });
    parsed.policy_id = computePolicyId(parsed);
    writeFileSync(policyBackupPath, JSON.stringify(parsed, null, 2), "utf-8");

    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
      criticality: "NORMAL",
      mutationSeq: 0,
      postInvestigation: false,
    }, null, 2), "utf-8");

    // 1. Direct implementation attempt via invoke_subagent -> DENIED, pending requirement created, NO DECISION recorded
    const inputInvoke = JSON.stringify({
      conversationId: "task2-lifecycle-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_invoke_blocked",
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-medium-worker", Role: "worker", Prompt: "Implement feature" }]
        }
      }
    });

    const raw1 = execFileSync("node", [preToolScript], { input: inputInvoke, encoding: "utf-8" });
    const res1 = JSON.parse(raw1.trim());
    assert.equal(res1.decision, "deny");
    assert.match(res1.reason, /POLICY_MISMATCH: Investigation strategy requires INVESTIGATE_FIRST/);

    const savedState1 = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(savedState1.pendingPolicyRequirement, "pendingPolicyRequirement must be set in active state");
    assert.equal(savedState1.pendingPolicyRequirement.selected_action, "INVESTIGATE_FIRST");
    assert.equal(savedState1.pendingPolicyRequirement.decision_type, "INVESTIGATION_STRATEGY");

    const eventsPath = ".agents/telemetry/events.jsonl";
    if (existsSync(eventsPath)) {
      const events1 = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const dec1 = events1.find(e => e.type === "DECISION" && e.decision_type === "INVESTIGATION_STRATEGY");
      assert.equal(dec1, undefined, "Zero DECISION event must be recorded on blocked attempt");
    }

    // 2. Second attempt to invoke implementation worker while requirement pending -> DENIED with pending requirement reason
    const raw2 = execFileSync("node", [preToolScript], { input: inputInvoke, encoding: "utf-8" });
    const res2 = JSON.parse(raw2.trim());
    assert.equal(res2.decision, "deny");
    assert.match(res2.reason, /Pending policy requirement INVESTIGATE_FIRST must be satisfied/);

    // 3. Generic operations (view_file, grep_search, git status) do NOT consume INVESTIGATE_FIRST
    const inputView = JSON.stringify({
      conversationId: "task2-lifecycle-conv",
      stepIdx: 2,
      toolCall: {
        id: "call_view_doc",
        name: "view_file",
        args: {
          AbsolutePath: resolve(process.cwd(), "package.json")
        }
      }
    });

    const raw3 = execFileSync("node", [preToolScript], { input: inputView, encoding: "utf-8" });
    const res3 = JSON.parse(raw3.trim());
    assert.equal(res3.decision, "allow");

    const savedState3 = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(savedState3.pendingPolicyRequirement, "Generic view_file must NOT consume pending requirement");
    assert.equal(savedState3.post_investigation, undefined, "Generic view_file must NOT set post_investigation");

    // 4. Investigator subagent starts -> ALLOWED, records factual DECISION, converts to investigationInFlight
    const inputInvestigator = JSON.stringify({
      conversationId: "task2-lifecycle-conv",
      stepIdx: 3,
      toolCall: {
        id: "call_investigator",
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-worker", Role: "investigator", Prompt: "Investigate root cause" }]
        }
      }
    });

    const raw4 = execFileSync("node", [preToolScript], { input: inputInvestigator, encoding: "utf-8" });
    const res4 = JSON.parse(raw4.trim());
    assert.equal(res4.decision, "allow");

    const savedState4 = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(savedState4.pendingPolicyRequirement, undefined, "pending requirement must be converted");
    assert.ok(savedState4.investigationInFlight, "investigationInFlight must be active");
    assert.equal(savedState4.post_investigation, false, "post_investigation must remain false while in flight");

    // Factual DECISION must be recorded immediately pre-action
    assert.ok(existsSync(eventsPath), "events.jsonl must exist");
    const events4 = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const dec4 = events4.find(e => e.type === "DECISION" && e.decision_type === "INVESTIGATION_STRATEGY");
    assert.ok(dec4, "Factual DECISION event must be recorded on investigator start");
    assert.equal(dec4.chosen_action, "INVESTIGATE_FIRST");

    // 5. While in flight, implementation worker delegation is blocked
    const raw5 = execFileSync("node", [preToolScript], { input: inputInvoke, encoding: "utf-8" });
    const res5 = JSON.parse(raw5.trim());
    assert.equal(res5.decision, "deny");
    assert.match(res5.reason, /Investigation is currently in flight/);

    // 6. invoke_subagent PostToolUse is only ACK: exact correlation MUST remain in flight.
    const postPayload = JSON.stringify({
      conversationId: "task2-lifecycle-conv",
      stepIdx: 3,
      toolCallId: "call_investigator",
      toolName: "invoke_subagent",
      toolArgs: {
        Subagents: [{ TypeName: "flash-worker", Role: "investigator", Prompt: "Investigate root cause" }]
      },
      result: { status: "SUCCESS", conversationId: "task2-investigator-child" },
    });
    execFileSync("node", [postToolScript], { input: postPayload, encoding: "utf-8" });

    const savedState6Ack = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(savedState6Ack.investigationInFlight, "successful invoke ACK must keep investigation in flight");
    assert.equal(savedState6Ack.post_investigation, false, "ACK must not satisfy post_investigation");
    assert.equal(savedState6Ack.investigationInFlight.childConversationId, "task2-investigator-child");

    // Bind the factual child to the originating investigation dispatch.
    const roleBindings = {
      mainConversationId: "task2-lifecycle-conv",
      bindings: {
        "task2-lifecycle-conv": {
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          source: "CONVERSATION_BOUND_IDENTITY",
        },
        "task2-investigator-child": {
          role: "WORKER",
          profile: "flash-worker",
          parentConversationId: "task2-lifecycle-conv",
          originToolCallId: "call_investigator",
          delegationKind: "INVESTIGATION",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
        },
      },
      conversations: {},
      pendingSubagents: [],
    };
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify(roleBindings, null, 2), "utf-8");

    // 7. Factual terminal Stop of the exact investigator child completes the investigation.
    execFileSync("node", [stopToolScript], {
      input: JSON.stringify({
        conversationId: "task2-investigator-child",
        fullyIdle: true,
        terminationReason: "end_turn",
      }),
      encoding: "utf-8",
    });

    const savedState7 = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(savedState7.investigationInFlight, undefined, "terminal investigator Stop must consume in-flight");
    assert.equal(savedState7.post_investigation, true, "factual child completion must satisfy post_investigation");
    assert.equal(savedState7.investigationCompletion.childConversationId, "task2-investigator-child");

    // 8. Post-investigation implementation worker delegation is now ALLOWED (post-investigation routes to FLASH_HIGH)
    const inputInvokeHigh = JSON.stringify({
      conversationId: "task2-lifecycle-conv",
      stepIdx: 4,
      toolCall: {
        id: "call_invoke_high",
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-worker", Role: "worker", Prompt: "Implement feature post-investigation" }]
        }
      }
    });
    const raw7 = execFileSync("node", [preToolScript], { input: inputInvokeHigh, encoding: "utf-8" });
    const res7 = JSON.parse(raw7.trim());
    assert.equal(res7.decision, "allow");
  } finally {
    writeFileSync(policyBackupPath, originalPolicy, "utf-8");
    cleanDreamTestState();
  }
});

test("Task 2 Causal Lifecycle: Generic operations (git status, grep_search) do NOT consume requirement", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
      pendingPolicyRequirement: {
        decision_type: "INVESTIGATION_STRATEGY",
        selected_action: "INVESTIGATE_FIRST",
        policy_source: "STATIC_POLICY_V1",
        baseline_action: "IMPLEMENT_DIRECT",
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    // 1. git status does NOT consume requirement
    const inputCmd = JSON.stringify({
      conversationId: "generic-check-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_status",
        name: "run_command",
        args: { CommandLine: "git status" }
      }
    });
    const res1 = JSON.parse(execFileSync("node", [preToolScript], { input: inputCmd, encoding: "utf-8" }).trim());
    assert.equal(res1.decision, "allow");

    const state1 = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(state1.pendingPolicyRequirement, "git status must NOT consume requirement");
    assert.equal(state1.post_investigation, false);

    // 2. grep_search does NOT consume requirement
    const inputGrep = JSON.stringify({
      conversationId: "generic-check-conv",
      stepIdx: 2,
      toolCall: {
        id: "call_grep",
        name: "grep_search",
        args: { Query: "foo", SearchPath: process.cwd() }
      }
    });
    const res2 = JSON.parse(execFileSync("node", [preToolScript], { input: inputGrep, encoding: "utf-8" }).trim());
    assert.equal(res2.decision, "allow");

    const state2 = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(state2.pendingPolicyRequirement, "grep_search must NOT consume requirement");
    assert.equal(state2.post_investigation, false);

    // 3. Worker implementation attempt is DENIED
    const inputWorker = JSON.stringify({
      conversationId: "generic-check-conv",
      stepIdx: 3,
      toolCall: {
        id: "call_worker",
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-medium-worker", Role: "worker", Prompt: "Build feature" }]
        }
      }
    });
    const res3 = JSON.parse(execFileSync("node", [preToolScript], { input: inputWorker, encoding: "utf-8" }).trim());
    assert.equal(res3.decision, "deny");
    assert.match(res3.reason, /Pending policy requirement INVESTIGATE_FIRST must be satisfied/);

    // No DECISION events were recorded
    const eventsPath = ".agents/telemetry/events.jsonl";
    if (existsSync(eventsPath)) {
      const events = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const dec = events.find(e => e.type === "DECISION");
      assert.equal(dec, undefined, "Zero DECISION event on generic operations");
    }
  } finally {
    cleanDreamTestState();
  }
});

test("Task 2 Causal Lifecycle: Investigation failure preserves post_investigation = false", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
      retry: true,
      attempt: 1,
      remainingAttempts: 1,
      prevRemainingAttempts: 1,
      retryReason: "MISSING_CONTEXT",
      lastWorkerProfile: "flash-medium-worker",
      investigationInFlight: {
        correlationKey: "test-corr-key",
        decision_type: "RETRY_ACTION",
        started_at: new Date().toISOString(),
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    // Subagent failed
    const postPayload = JSON.stringify({
      conversationId: "fail-conv",
      stepIdx: 1,
      correlationKey: "test-corr-key",
      toolName: "invoke_subagent",
      toolArgs: { Subagents: [{ TypeName: "flash-worker", Role: "investigator" }] },
      error: "Investigation subagent crashed with timeout",
    });
    execFileSync("node", [postToolScript], { input: postPayload, encoding: "utf-8" });

    const state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.investigationInFlight, undefined, "In flight must be cleared");
    assert.equal(state.post_investigation, false, "post_investigation MUST remain false on failure");

    // Subsequent worker attempt must still be denied because post_investigation remains false
    const inputWorker = JSON.stringify({
      conversationId: "fail-conv",
      stepIdx: 2,
      toolCall: {
        id: "call_worker_after_fail",
        name: "invoke_subagent",
        args: {
          remainingAttempts: 1,
          Subagents: [{ TypeName: "flash-medium-worker", Role: "worker", Prompt: "Retry feature" }]
        }
      }
    });
    const resWorker = JSON.parse(execFileSync("node", [preToolScript], { input: inputWorker, encoding: "utf-8" }).trim());
    assert.equal(resWorker.decision, "deny");
    assert.match(resWorker.reason, /POLICY_MISMATCH: Retry policy selected INVESTIGATE_FIRST/);
  } finally {
    cleanDreamTestState();
  }
});

test("Task 2 Causal Lifecycle: Preserves origin decision_type for RETRY_ACTION", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
      retry: true,
      attempt: 1,
      remainingAttempts: 1,
      prevRemainingAttempts: 1,
      retryReason: "MISSING_CONTEXT",
      lastWorkerProfile: "flash-medium-worker",
    }, null, 2), "utf-8");

    // 1. Worker retry attempted -> DENIED, pending requirement set with RETRY_ACTION
    const inputRetry = JSON.stringify({
      conversationId: "task2-retry-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_retry_blocked",
        name: "invoke_subagent",
        args: {
          remainingAttempts: 1,
          Subagents: [{ TypeName: "flash-medium-worker", Role: "worker", Prompt: "Retry feature" }]
        }
      }
    });

    const raw1 = execFileSync("node", [preToolScript], { input: inputRetry, encoding: "utf-8" });
    const res1 = JSON.parse(raw1.trim());
    assert.equal(res1.decision, "deny");
    assert.match(res1.reason, /POLICY_MISMATCH: Retry policy selected INVESTIGATE_FIRST/);

    const savedState1 = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(savedState1.pendingPolicyRequirement);
    assert.equal(savedState1.pendingPolicyRequirement.selected_action, "INVESTIGATE_FIRST");
    assert.equal(savedState1.pendingPolicyRequirement.decision_type, "RETRY_ACTION");

    // 2. Investigator starts -> ALLOWED, records DECISION with decision_type: RETRY_ACTION
    const inputInvestigator = JSON.stringify({
      conversationId: "task2-retry-conv",
      stepIdx: 2,
      toolCall: {
        id: "call_investigator_retry",
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-worker", Role: "investigator", Prompt: "Investigate context gap" }]
        }
      }
    });

    const raw2 = execFileSync("node", [preToolScript], { input: inputInvestigator, encoding: "utf-8" });
    const res2 = JSON.parse(raw2.trim());
    assert.equal(res2.decision, "allow");

    const eventsPath = ".agents/telemetry/events.jsonl";
    assert.ok(existsSync(eventsPath));
    const events = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const dec = events.find(e => e.type === "DECISION" && e.decision_type === "RETRY_ACTION" && e.chosen_action === "INVESTIGATE_FIRST");
    assert.ok(dec, "RETRY_ACTION origin must be preserved in DECISION record");
  } finally {
    cleanDreamTestState();
  }
});

test("Task 2 Explicit REPLAN Execution: worker retry denied, DECISION(REPLAN) pre-transition, state PLANNED, no pending requirement", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
      state: "EXECUTING",
      retry: true,
      attempt: 1,
      remainingAttempts: 1,
      prevRemainingAttempts: 1,
      retryReason: "MISINTERPRETED_REQUIREMENT",
      lastWorkerProfile: "flash-medium-worker",
    }, null, 2), "utf-8");

    // 1. Worker retry attempted -> DECISION(REPLAN) pre-transition, state PLANNED, worker DENIED, no pending REPLAN requirement
    const inputRetry = JSON.stringify({
      conversationId: "replan-causal-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_worker_retry_replan",
        name: "invoke_subagent",
        args: {
          remainingAttempts: 1,
          Subagents: [{ TypeName: "flash-medium-worker", Role: "worker", Prompt: "Retry feature" }]
        }
      }
    });

    const raw1 = execFileSync("node", [preToolScript], { input: inputRetry, encoding: "utf-8" });
    const res1 = JSON.parse(raw1.trim());
    assert.equal(res1.decision, "deny");
    assert.match(res1.reason, /POLICY_MISMATCH: Retry policy selected REPLAN/);

    const savedState1 = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(savedState1.state, "PLANNED", "State must deterministically transition to PLANNED");
    assert.notEqual(savedState1.state, "PLANNING", "State must NEVER be PLANNING");
    assert.equal(savedState1.pendingPolicyRequirement, undefined, "Zero pending requirement waiting for arbitrary tools");

    // Immediately pre-transition: factual DECISION(REPLAN) is recorded
    const eventsPath = ".agents/telemetry/events.jsonl";
    assert.ok(existsSync(eventsPath), "events.jsonl must exist");
    const events1 = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const dec1 = events1.find(e => e.type === "DECISION" && e.decision_type === "RETRY_ACTION" && e.chosen_action === "REPLAN");
    assert.ok(dec1, "Factual DECISION(REPLAN) must be recorded immediately pre-transition");
    assert.equal(dec1.baseline_action, "REPLAN");

    // 2. Generic control plane write (write_to_file) is allowed as normal and does NOT trigger replan or change state
    const inputPlanWrite = JSON.stringify({
      conversationId: "replan-causal-conv",
      stepIdx: 2,
      activeRole: "ORCHESTRATOR",
      toolCall: {
        id: "call_write_plan",
        name: "write_to_file",
        args: {
          TargetFile: resolve(process.cwd(), ".agents/plans/test-replan.md"),
          CodeContent: "# Corrected Replan",
          Overwrite: true,
        }
      }
    });

    const raw2 = execFileSync("node", [preToolScript], { input: inputPlanWrite, encoding: "utf-8" });
    const res2 = JSON.parse(raw2.trim());
    assert.equal(res2.decision, "allow");

    const savedState2 = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(savedState2.state, "PLANNED", "State remains PLANNED without generic tool side effect");

    // Clean up created test plan file
    try { unlinkSync(".agents/plans/test-replan.md"); } catch {}

    // 3. Invalid state transition: if state cannot transition to PLANNED, do NOT record DECISION(REPLAN), fail closed to HUMAN_GATE
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
      state: "INTAKE", // INTAKE cannot transition to PLANNED on retry
      retry: true,
      attempt: 1,
      remainingAttempts: 1,
      prevRemainingAttempts: 1,
      retryReason: "MISINTERPRETED_REQUIREMENT",
      lastWorkerProfile: "flash-medium-worker",
    }, null, 2), "utf-8");

    // Remove events to test zero DECISION recording on invalid transition
    unlinkSync(eventsPath);

    const inputInvalid = JSON.stringify({
      conversationId: "replan-invalid-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_worker_invalid",
        name: "invoke_subagent",
        args: {
          remainingAttempts: 1,
          Subagents: [{ TypeName: "flash-medium-worker", Role: "worker", Prompt: "Retry feature" }]
        }
      }
    });

    const raw3 = execFileSync("node", [preToolScript], { input: inputInvalid, encoding: "utf-8" });
    const res3 = JSON.parse(raw3.trim());
    assert.equal(res3.decision, "deny");
    assert.match(res3.reason, /REPLAN_INVALID_TRANSITION/);

    const savedState3 = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(savedState3.state, "HUMAN_GATE", "Invalid transition must fail closed to HUMAN_GATE");
    assert.equal(existsSync(eventsPath), false, "Zero DECISION(REPLAN) recorded when state transition is invalid");

    // 3. Rejection of PLANNING in validatePolicy and policy schema
    const basePolicy = {
      schema: "orchestra.exploration-policy.v1",
      policy_id: "placeholder",
      base_policy: null,
      description: "Test policy",
      created_at: "2026-09-17T00:00:00Z",
      rules: [
        {
          id: "rule-planning-test",
          decision_type: "WORKER_TIER",
          priority: 10,
          when: {
            task_action: ["IMPLEMENT"],
            state: ["PLANNING"],
          },
          choose: "FLASH_MEDIUM",
        }
      ]
    };
    try {
      basePolicy.policy_id = computePolicyId(basePolicy);
    } catch {}

    const valRes = validatePolicy(basePolicy);
    assert.equal(valRes.valid, false, "validatePolicy MUST reject state: ['PLANNING']");
    assert.match(valRes.errors.join("; "), /elements must be valid enum strings/, "Validator error mentions enum strings");
  } finally {
    try { unlinkSync(".agents/plans/test-replan.md"); } catch {}
    cleanDreamTestState();
  }
});

test("Task 1 Exact Investigation Correlation: normative counterexamples A through G", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });

    const setupInFlightA = () => {
      writeFileSync(".agents/state/active-state.json", JSON.stringify({
        activeRole: "ORCHESTRATOR",
        taskAction: "IMPLEMENT",
        taskDomain: "CODE",
        criticality: "NORMAL",
        conversationId: "conv-A",
        investigationInFlight: {
          correlationKey: "corr-key-A",
          correlation_key: "corr-key-A",
          decision_type: "INVESTIGATION_STRATEGY",
          policy_source: "STATIC_POLICY_V1",
          toolCallId: "call-A",
          tool_call_id: "call-A",
          stepIdx: 1,
          step_idx: 1,
          conversationId: "conv-A",
          conversation_id: "conv-A",
          subagentRole: "investigator",
          subagentProfile: "flash-worker",
          started_at: new Date().toISOString(),
        },
        post_investigation: false,
      }, null, 2), "utf-8");
    };

    // A. conv-A, call-A vs conv-B, call-B -> A remains in flight, post_investigation = false
    setupInFlightA();
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-B",
        toolCallId: "call-B",
        stepIdx: 1,
        toolName: "invoke_subagent",
        toolArgs: { Subagents: [{ Role: "investigator", TypeName: "flash-worker" }] },
        result: { status: "SUCCESS" },
      }),
      encoding: "utf-8"
    });
    let stateA = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(stateA.investigationInFlight, "Counterexample A: in-flight must NOT be consumed by different conversation and tool call");
    assert.equal(stateA.post_investigation, false, "Counterexample A: post_investigation must remain false");

    // B. Same conversation, different toolCallId -> does not close A
    setupInFlightA();
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolCallId: "call-different",
        stepIdx: 2,
        toolName: "invoke_subagent",
        toolArgs: { Subagents: [{ Role: "investigator", TypeName: "flash-worker" }] },
        result: { status: "SUCCESS" },
      }),
      encoding: "utf-8"
    });
    let stateB = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(stateB.investigationInFlight, "Counterexample B: in-flight must NOT be consumed by different tool call in same conversation");
    assert.equal(stateB.post_investigation, false, "Counterexample B: post_investigation must remain false");

    // C. Same toolCallId, incompatible conversation -> does not close A
    setupInFlightA();
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-incompatible",
        toolCallId: "call-A",
        stepIdx: 1,
        toolName: "invoke_subagent",
        toolArgs: { Subagents: [{ Role: "investigator", TypeName: "flash-worker" }] },
        result: { status: "SUCCESS" },
      }),
      encoding: "utf-8"
    });
    let stateC = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(stateC.investigationInFlight, "Counterexample C: in-flight must NOT be consumed by incompatible conversation");
    assert.equal(stateC.post_investigation, false, "Counterexample C: post_investigation must remain false");

    // D. manage_subagents of another child -> does not close A
    setupInFlightA();
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolName: "manage_subagents",
        toolArgs: { Action: "status", ConversationIds: ["unrelated-child-worker"] },
        result: { status: "SUCCESS", subagentId: "unrelated-child-worker", role: "worker" },
      }),
      encoding: "utf-8"
    });
    let stateD = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(stateD.investigationInFlight, "Counterexample D: manage_subagents of unrelated child must NOT close in-flight");
    assert.equal(stateD.post_investigation, false, "Counterexample D: post_investigation must remain false");

    // E. Exactly correlated completion -> closes A, post_investigation = true
    setupInFlightA();
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolCallId: "call-A",
        stepIdx: 1,
        toolName: "invoke_subagent",
        toolArgs: { Subagents: [{ Role: "investigator", TypeName: "flash-worker" }] },
        result: { status: "SUCCESS" },
      }),
      encoding: "utf-8"
    });
    let stateE = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(stateE.investigationInFlight, undefined, "Counterexample E: exactly correlated completion must close in-flight");
    assert.equal(stateE.post_investigation, true, "Counterexample E: post_investigation must become true");

    // F. Exactly correlated completion + FAILED/error -> closes in-flight, post_investigation = false
    setupInFlightA();
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolCallId: "call-A",
        stepIdx: 1,
        toolName: "invoke_subagent",
        toolArgs: { Subagents: [{ Role: "investigator", TypeName: "flash-worker" }] },
        error: "Subagent crashed with unhandled exception",
      }),
      encoding: "utf-8"
    });
    let stateF = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(stateF.investigationInFlight, undefined, "Counterexample F: failed invocation dispatch must close in-flight");
    assert.equal(stateF.post_investigation, false, "Counterexample F: post_investigation must remain false on error");

    // G. Cancel exactly correlated -> closes in-flight, post_investigation = false
    setupInFlightA();
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolCallId: "call-A",
        stepIdx: 1,
        toolName: "invoke_subagent",
        toolArgs: { Subagents: [{ Role: "investigator", TypeName: "flash-worker" }] },
        cancelled: true,
      }),
      encoding: "utf-8"
    });
    let stateG = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(stateG.investigationInFlight, undefined, "Counterexample G: cancelled invocation dispatch must close in-flight");
    assert.equal(stateG.post_investigation, false, "Counterexample G: post_investigation must remain false on cancel");
  } finally {
    cleanDreamTestState();
  }
});

test("Task 1 Exact Investigation Correlation: normative tests H through M", () => {
  cleanDreamTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });

    // TEST H: conv-A + call-A stored vs conv-A + missing toolCallId -> NO MATCH
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "conv-A",
      investigationInFlight: {
        toolCallId: "call-A",
        tool_call_id: "call-A",
        conversationId: "conv-A",
        conversation_id: "conv-A",
        subagentRole: "investigator",
        subagentProfile: "flash-worker",
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolName: "invoke_subagent",
        toolArgs: { Subagents: [{ Role: "investigator", TypeName: "flash-worker" }] },
        result: { status: "SUCCESS" },
      }),
      encoding: "utf-8"
    });
    let stateH = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(stateH.investigationInFlight, "TEST H: missing toolCallId must NOT match stored call-A");
    assert.equal(stateH.post_investigation, false, "TEST H: post_investigation must remain false");

    // TEST I: conv-A + call-A + corr-A stored vs conv-A + call-A + missing corr-A -> MATCH on toolCallId
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "conv-A",
      investigationInFlight: {
        correlationKey: "corr-A",
        correlation_key: "corr-A",
        toolCallId: "call-A",
        tool_call_id: "call-A",
        conversationId: "conv-A",
        conversation_id: "conv-A",
        subagentRole: "investigator",
        subagentProfile: "flash-worker",
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolCallId: "call-A",
        toolName: "invoke_subagent",
        toolArgs: { Subagents: [{ Role: "investigator", TypeName: "flash-worker" }] },
        result: { status: "SUCCESS" },
      }),
      encoding: "utf-8"
    });
    let stateI = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(stateI.investigationInFlight, "TEST I: exact invocation identity is still only an ACK and must remain in flight");
    assert.equal(stateI.post_investigation, false, "TEST I: ACK must not satisfy post_investigation");

    // TEST J: conv-A + call-A stored vs conv-A without toolCallId/executionId/childConversationId -> NO MATCH
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "conv-A",
      investigationInFlight: {
        toolCallId: "call-A",
        tool_call_id: "call-A",
        conversationId: "conv-A",
        conversation_id: "conv-A",
        subagentRole: "investigator",
        subagentProfile: "flash-worker",
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolName: "invoke_subagent",
        toolArgs: { Subagents: [{ Role: "investigator", TypeName: "flash-worker" }] },
        result: { status: "SUCCESS" },
      }),
      encoding: "utf-8"
    });
    let stateJ = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(stateJ.investigationInFlight, "TEST J: completion without hard identity must NOT match");
    assert.equal(stateJ.post_investigation, false, "TEST J: post_investigation must remain false");

    // TEST K: parent=A, child=investigator-A, role=investigator, profile=flash-worker stored vs parent=A, child=investigator-B, role=investigator, profile=flash-worker in manage_subagents -> NO MATCH
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "conv-A",
      investigationInFlight: {
        parentConversationId: "conv-A",
        parent_conversation_id: "conv-A",
        childConversationId: "investigator-A",
        child_conversation_id: "investigator-A",
        subagentRole: "investigator",
        subagent_role: "investigator",
        subagentProfile: "flash-worker",
        subagent_profile: "flash-worker",
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolName: "manage_subagents",
        toolArgs: { ConversationId: "investigator-B", Role: "investigator", TypeName: "flash-worker" },
        result: { status: "SUCCESS", subagentId: "investigator-B", role: "investigator", profile: "flash-worker" },
      }),
      encoding: "utf-8"
    });
    let stateK = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(stateK.investigationInFlight, "TEST K: child mismatch (investigator-A vs investigator-B) must NOT match");
    assert.equal(stateK.post_investigation, false, "TEST K: post_investigation must remain false");

    // TEST L: parent=A, child=investigator-A stored vs exact child=investigator-A -> MATCH
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "conv-A",
      investigationInFlight: {
        parentConversationId: "conv-A",
        parent_conversation_id: "conv-A",
        childConversationId: "investigator-A",
        child_conversation_id: "investigator-A",
        subagentRole: "investigator",
        subagent_role: "investigator",
        subagentProfile: "flash-worker",
        subagent_profile: "flash-worker",
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolName: "manage_subagents",
        toolArgs: { ConversationId: "investigator-A", Role: "investigator", TypeName: "flash-worker" },
        result: { status: "SUCCESS", subagentId: "investigator-A", role: "investigator", profile: "flash-worker" },
      }),
      encoding: "utf-8"
    });
    let stateL = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(stateL.investigationInFlight, "TEST L: manage_subagents exact child observation is not a terminal lifecycle event");
    assert.equal(stateL.post_investigation, false, "TEST L: manage_subagents must not satisfy post_investigation");

    // TEST M: two investigators sharing role/profile/parent, completion contains only role/profile/parent -> NO MATCH (no FIFO/guesswork)
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "conv-A",
      investigationInFlight: {
        parentConversationId: "conv-A",
        parent_conversation_id: "conv-A",
        childConversationId: "investigator-A",
        child_conversation_id: "investigator-A",
        subagentRole: "investigator",
        subagent_role: "investigator",
        subagentProfile: "flash-worker",
        subagent_profile: "flash-worker",
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "conv-A",
        toolName: "manage_subagents",
        toolArgs: { Role: "investigator", TypeName: "flash-worker" },
        result: { status: "SUCCESS", role: "investigator", profile: "flash-worker" },
      }),
      encoding: "utf-8"
    });
    let stateM = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(stateM.investigationInFlight, "TEST M: completion with only role/profile/parent must NOT match without hard child identity");
    assert.equal(stateM.post_investigation, false, "TEST M: post_investigation must remain false without hard child identity");
  } finally {
    cleanDreamTestState();
  }
});
