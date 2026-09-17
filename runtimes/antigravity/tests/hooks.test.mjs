import "../.agents/hooks/hooks.test.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computePolicyId } from "../.agents/dream/policy-engine.mjs";

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



