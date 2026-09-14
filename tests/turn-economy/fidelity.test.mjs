import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  TASK_FIDELITY_REQUIREMENTS,
  EXPECTED_ROUTES,
  getExpectedRoute,
  classifyRoleAttributionConfidence,
  evaluateTaskFidelity,
} from "../../benchmarks/turn-economy/fidelity.mjs";
import { extractChildTranscriptEvidence } from "../../benchmarks/turn-economy/run.mjs";
import { decideRoute as decideCodexRoute } from "../../runtimes/codex/.codex/astra-orchestra/routing-policy.mjs";
import { decideRoute as decideAgyRoute } from "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const orchestraRoot = resolve(__dirname, "../..");
const resultsDir = resolve(orchestraRoot, "benchmarks/turn-economy/results");

test("fidelity: expected worker route classification", () => {
  // Simple, multi, investigation expect worker delegation
  assert.equal(TASK_FIDELITY_REQUIREMENTS.simple.delegationExpected, true);
  assert.equal(TASK_FIDELITY_REQUIREMENTS.multi.delegationExpected, true);
  assert.equal(TASK_FIDELITY_REQUIREMENTS.investigation.delegationExpected, true);

  // Status, lookup, critical do not require standard worker delegation
  assert.equal(TASK_FIDELITY_REQUIREMENTS.status.delegationExpected, false);
  assert.equal(TASK_FIDELITY_REQUIREMENTS.lookup.delegationExpected, false);
  assert.equal(TASK_FIDELITY_REQUIREMENTS.critical.delegationExpected, false);

  const codexSimpleRoute = getExpectedRoute("simple", "codex");
  assert.equal(codexSimpleRoute.orchestrator, "terra-medium");
  assert.equal(codexSimpleRoute.worker, "luna-high");
  assert.equal(codexSimpleRoute.delegationExpected, true);

  // Authoritative policy: simple implementation routes to flash-low-worker (gemini-3.8-flash-low)
  const agySimpleRoute = getExpectedRoute("simple", "antigravity");
  assert.equal(agySimpleRoute.orchestrator, "flash-orchestrator");
  assert.equal(agySimpleRoute.worker, "flash-low-worker");
  assert.equal(agySimpleRoute.workerModel, "gemini-3.8-flash-low");
  assert.equal(agySimpleRoute.delegationExpected, true);
});

test("fidelity: dynamic policy derivation eliminates route drift", () => {
  // Verify Codex policy alignment
  const codexPolicySimple = decideCodexRoute({ taskAction: "IMPLEMENT", implementationComplexity: "simple" });
  const codexExpectedSimple = getExpectedRoute("simple", "codex");
  assert.equal(codexExpectedSimple.worker, codexPolicySimple.profile);
  assert.equal(codexExpectedSimple.workerModel, codexPolicySimple.model);

  const codexPolicyMulti = decideCodexRoute({ taskAction: "IMPLEMENT", implementationComplexity: "normal" });
  const codexExpectedMulti = getExpectedRoute("multi", "codex");
  assert.equal(codexExpectedMulti.worker, codexPolicyMulti.profile);
  assert.equal(codexExpectedMulti.workerModel, codexPolicyMulti.model);

  // Verify Antigravity policy alignment
  const agyPolicySimple = decideAgyRoute({ taskAction: "IMPLEMENT", implementationComplexity: "simple" });
  const agyExpectedSimple = getExpectedRoute("simple", "antigravity");
  assert.equal(agyExpectedSimple.workerModel, agyPolicySimple.model);

  const agyPolicyMulti = decideAgyRoute({ taskAction: "IMPLEMENT", implementationComplexity: "normal" });
  const agyExpectedMulti = getExpectedRoute("multi", "antigravity");
  assert.equal(agyExpectedMulti.workerModel, agyPolicyMulti.model);
});

test("fidelity: dry-run returns SIMULATED status and LOW confidence", () => {
  const dryRunCodex = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "codex",
    dryRun: true,
    subagentInvocations: 1,
    mutationActor: "WORKER",
    runtimeLoaded: true,
  });

  assert.equal(dryRunCodex.fidelityStatus, "SIMULATED");
  assert.equal(dryRunCodex.confidence, "LOW");
  assert.equal(dryRunCodex.writeActorValid, true);

  const dryRunAgy = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "antigravity",
    dryRun: true,
    subagentInvocations: 1,
    mutationActor: "WORKER",
    runtimeLoaded: true,
  });

  assert.equal(dryRunAgy.fidelityStatus, "SIMULATED");
  assert.equal(dryRunAgy.confidence, "LOW");
  assert.equal(dryRunAgy.writeActorValid, true);
});

test("fidelity: subagent spawn alone does NOT grant PASS if orchestrator mutates product code", () => {
  // Scenario: Orchestrator spawned a subagent, but wrote product code itself
  const evalResult = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 1,
    mutationActor: "ORCHESTRATOR",
    orchestratorWorkspaceWrites: 1,
    mutationEvents: [
      {
        path: "src/formatter.js",
        actorRole: "ORCHESTRATOR",
        actorId: "orchestrator-main",
        confidence: "HIGH",
        evidenceSource: "hook_payload",
      },
    ],
    runtimeLoaded: true,
    orchestratorIdentity: "flash-orchestrator",
    workerObserved: true,
    confidenceEvidence: { hasExplicitAgentRole: true },
  });

  assert.equal(evalResult.fidelityStatus, "FAIL");
  assert.equal(evalResult.writeActorValid, false);
  assert.ok(
    evalResult.violations.includes("FIDELITY_VIOLATION: ORCHESTRATOR_PRODUCT_WRITE_ALLOWED"),
    "Orchestrator product write must fail closed even when subagent is present"
  );
});

test("fidelity: unknown mutation actor fails closed", () => {
  const evalResult = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 1,
    mutationActor: "UNKNOWN",
    mutationEvents: [
      {
        path: "src/formatter.js",
        actorRole: "UNKNOWN",
        actorId: null,
        confidence: "LOW",
        evidenceSource: "unresolved",
      },
    ],
    runtimeLoaded: true,
    orchestratorIdentity: "flash-orchestrator",
    workerObserved: true,
    confidenceEvidence: {},
  });

  assert.equal(evalResult.fidelityStatus, "FAIL");
  assert.equal(evalResult.writeActorValid, false);
  assert.ok(
    evalResult.violations.includes("FIDELITY_VIOLATION: MUTATION_ACTOR_UNKNOWN"),
    "Unknown actor mutations must fail closed"
  );
});

test("fidelity: per-mutation event attribution verifies true worker author", () => {
  // Valid worker mutation event with HIGH confidence
  const evalResult = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 1,
    mutationEvents: [
      {
        path: "src/formatter.js",
        actorRole: "WORKER",
        actorId: "subagent-c1234",
        agentProfile: "flash-low-worker",
        model: "gemini-3.8-flash-low",
        confidence: "HIGH",
        evidenceSource: "hook_payload",
      },
    ],
    runtimeLoaded: true,
    orchestratorIdentity: "flash-orchestrator",
    workerObserved: true,
    confidenceEvidence: { hasExplicitAgentRole: true },
    workerCompletionClaimed: true,
    workerValidationObserved: true,
    workerValidationVerified: true,
    workerValidationFresh: true,
    workerValidationActor: "WORKER",
    workerValidationExitCode: 0,
    acceptanceObserved: true,
    acceptanceActor: "ORCHESTRATOR",
    acceptanceState: "ACCEPTED",
  });

  assert.equal(evalResult.fidelityStatus, "PASS");
  assert.equal(evalResult.confidence, "HIGH");
  assert.equal(evalResult.writeActorValid, true);
  assert.equal(evalResult.observed.productMutationActor, "WORKER");
});

test("fidelity: direct / read-only tasks pass without worker delegation", () => {
  const statusEval = evaluateTaskFidelity({
    taskKey: "status",
    runtime: "codex",
    subagentInvocations: 0,
    mutationActor: "NONE",
    runtimeLoaded: true,
    orchestratorIdentity: "terra-medium",
    workerObserved: false,
    confidenceEvidence: { hasExplicitAgentRole: true },
  });

  assert.equal(statusEval.fidelityStatus, "PASS");
  assert.equal(statusEval.writeActorValid, true);
  assert.equal(statusEval.observed.delegation, false);
  assert.equal(statusEval.violations.length, 0);

  const lookupEval = evaluateTaskFidelity({
    taskKey: "lookup",
    runtime: "antigravity",
    subagentInvocations: 0,
    mutationActor: "NONE",
    runtimeLoaded: true,
    orchestratorIdentity: "flash-orchestrator",
    workerObserved: false,
    confidenceEvidence: { hasExplicitAgentRole: true },
  });

  assert.equal(lookupEval.fidelityStatus, "PASS");
  assert.equal(lookupEval.writeActorValid, true);
});

test("fidelity: fidelity PASS logic when worker performs implementation", () => {
  const evalResult = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "codex",
    subagentInvocations: 1,
    mutationActor: "WORKER",
    runtimeLoaded: true,
    orchestratorIdentity: "terra-medium",
    workerObserved: true,
    confidenceEvidence: {
      hasExplicitThreadId: true,
      hasExplicitAgentRole: true,
    },
    workerCompletionClaimed: true,
    workerValidationObserved: true,
    workerValidationVerified: true,
    workerValidationFresh: true,
    workerValidationActor: "WORKER",
    workerValidationExitCode: 0,
    acceptanceObserved: true,
    acceptanceActor: "ORCHESTRATOR",
    acceptanceState: "ACCEPTED",
  });

  assert.equal(evalResult.fidelityStatus, "PASS");
  assert.equal(evalResult.confidence, "HIGH");
  assert.equal(evalResult.observed.delegation, true);
  assert.equal(evalResult.observed.productMutationActor, "WORKER");
  assert.equal(evalResult.writeActorValid, true);
  assert.equal(evalResult.violations.length, 0);
});

test("fidelity: fidelity FAIL when expected worker is absent", () => {
  const evalResult = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 0,
    mutationActor: "NONE",
    runtimeLoaded: true,
    orchestratorIdentity: "generic-agent",
    workerObserved: false,
    confidenceEvidence: { hasSubagentTrace: false },
  });

  assert.equal(evalResult.fidelityStatus, "FAIL");
  assert.equal(evalResult.writeActorValid, false);
  assert.ok(evalResult.violations.includes("EXPECTED_WORKER_ABSENT"));
});

test("fidelity: fidelity FAIL when orchestrator writes product code", () => {
  const evalResult = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 0,
    mutationActor: "ORCHESTRATOR",
    runtimeLoaded: true,
    orchestratorIdentity: "generic-agent",
    workerObserved: false,
    confidenceEvidence: {},
    gaps: ["ARCHITECTURAL_ENFORCEMENT_GAP"],
  });

  assert.equal(evalResult.fidelityStatus, "FAIL");
  assert.equal(evalResult.writeActorValid, false);
  assert.ok(evalResult.violations.includes("FIDELITY_VIOLATION: ORCHESTRATOR_PRODUCT_WRITE_ALLOWED"));
  assert.ok(evalResult.violations.includes("ARCHITECTURAL_ENFORCEMENT_GAP"));
});

test("fidelity: role attribution confidence levels", () => {
  // HIGH: Explicit thread or agent role
  assert.equal(
    classifyRoleAttributionConfidence({ hasExplicitThreadId: true, hasExplicitAgentRole: true }),
    "HIGH"
  );
  assert.equal(
    classifyRoleAttributionConfidence({ hasSubagentTrace: true }),
    "HIGH"
  );

  // MEDIUM: Strong timing & requestedAgent correlation
  assert.equal(
    classifyRoleAttributionConfidence({ hasRequestedAgent: true, hasInvocationTimingCorrelation: true }),
    "MEDIUM"
  );

  // LOW: Indirect inference
  assert.equal(
    classifyRoleAttributionConfidence({}),
    "LOW"
  );
  assert.equal(
    classifyRoleAttributionConfidence({ hasRequestedAgent: true }),
    "LOW"
  );
});

test("fidelity: historical baselines remain intact and readable", () => {
  const baselineV1 = resolve(resultsDir, "baseline-v1.json");
  const hardenedBaseline = resolve(resultsDir, "hardened-baseline.json");
  const capabilityMatrix = resolve(resultsDir, "capability-matrix.json");

  assert.ok(existsSync(baselineV1), "baseline-v1.json must exist");
  assert.ok(existsSync(hardenedBaseline), "hardened-baseline.json must exist");
  assert.ok(existsSync(capabilityMatrix), "capability-matrix.json must exist");

  const v1Data = JSON.parse(readFileSync(baselineV1, "utf8"));
  const hardenedData = JSON.parse(readFileSync(hardenedBaseline, "utf8"));
  const matrixData = JSON.parse(readFileSync(capabilityMatrix, "utf8"));

  assert.ok(Array.isArray(v1Data) || typeof v1Data === "object");
  assert.ok(Array.isArray(hardenedData) || typeof hardenedData === "object");
  assert.ok(typeof matrixData === "object");
});

test("fidelity: negative regression 8: worker spawned but orchestrator edits product yields fidelity FAIL", () => {
  const evalResult = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 1,
    mutationActor: "ORCHESTRATOR",
    orchestratorWorkspaceWrites: 1,
    mutationEvents: [
      {
        path: "src/formatter.js",
        actorRole: "ORCHESTRATOR",
        actorId: "orch-conv-main",
        confidence: "HIGH",
        evidenceSource: "hook_payload",
      },
    ],
    runtimeLoaded: true,
    orchestratorIdentity: "flash-orchestrator",
    workerObserved: true,
    confidenceEvidence: { hasExplicitAgentRole: true },
  });

  assert.equal(evalResult.fidelityStatus, "FAIL");
  assert.equal(evalResult.writeActorValid, false);
  assert.ok(
    evalResult.violations.includes("FIDELITY_VIOLATION: ORCHESTRATOR_PRODUCT_WRITE_ALLOWED"),
    "Orchestrator product write must fail closed"
  );
});

test("fidelity: negative regression 9: worker mutations correctly attributed are eligible for PASS", () => {
  const evalResult = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 1,
    mutationActor: "WORKER",
    mutationEvents: [
      {
        path: "src/formatter.js",
        actorRole: "WORKER",
        actorId: "child-worker-conv",
        agentProfile: "flash-low-worker",
        model: "gemini-3.8-flash-low",
        confidence: "HIGH",
        evidenceSource: "RUNTIME_IDENTITY",
      },
      {
        path: "test/formatter.test.js",
        actorRole: "WORKER",
        actorId: "child-worker-conv",
        agentProfile: "flash-low-worker",
        model: "gemini-3.8-flash-low",
        confidence: "HIGH",
        evidenceSource: "RUNTIME_IDENTITY",
      },
    ],
    orchestratorWorkspaceWrites: 0,
    unknownWorkspaceWrites: 0,
    runtimeLoaded: true,
    orchestratorIdentity: "flash-orchestrator",
    workerObserved: true,
    confidenceEvidence: { hasExplicitAgentRole: true },
    workerCompletionClaimed: true,
    workerValidationObserved: true,
    workerValidationVerified: true,
    workerValidationFresh: true,
    workerValidationActor: "WORKER",
    workerValidationExitCode: 0,
    acceptanceObserved: true,
    acceptanceActor: "ORCHESTRATOR",
    acceptanceState: "ACCEPTED",
  });

  assert.equal(evalResult.fidelityStatus, "PASS");
  assert.equal(evalResult.writeActorValid, true);
  assert.equal(evalResult.observed.productMutationActor, "WORKER");
  assert.equal(evalResult.observed.orchestratorWorkspaceWrites, 0);
  assert.equal(evalResult.violations.length, 0);
});

test("fidelity: negative regression 10: flash-worker naming matches actual agent inventory and policy", () => {
  const agentsDir = resolve(orchestraRoot, "runtimes/antigravity/.agents/agents");
  assert.ok(existsSync(resolve(agentsDir, "flash-worker.md")), "flash-worker.md must exist in agent inventory");
  assert.ok(!existsSync(resolve(agentsDir, "flash-high-worker.md")), "flash-high-worker.md must NOT exist in agent inventory");

  const invRoute = getExpectedRoute("investigation", "antigravity");
  assert.equal(invRoute.worker, "flash-worker", "Investigation route must specify real profile flash-worker");
  assert.equal(invRoute.workerModel, "gemini-3.8-flash-high");

  const policyRoute = decideAgyRoute({ taskAction: "INVESTIGATE" });
  assert.equal(policyRoute.model, "gemini-3.8-flash-high");

  assert.equal(EXPECTED_ROUTES.antigravity.worker.investigation.profile, "flash-worker");
});

test("fidelity: negative regression 11: AGY child-conversation pattern — worker spawned, parent mutation_events empty => FIDELITY_PASS with WORKER_PROXY", () => {
  // In AGY multi-agent execution the worker runs in a child conversation context.
  // The parent post-tool-telemetry hook cannot observe child tool calls, so
  // mutation_events is empty while subagentInvocations=1 and success=true.
  // This should yield FIDELITY_PASS — not EXPECTED_WORKER_ABSENT.
  const result = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 1,
    mutationActor: "NONE",          // parent sees no direct mutations
    mutationEvents: [],             // empty — child mutations invisible to parent
    orchestratorWorkspaceWrites: 0,
    unknownWorkspaceWrites: 0,
    controlPlaneWrites: 3,
    dryRun: false,
    runtimeLoaded: true,
    orchestratorIdentity: "flash-orchestrator",
    workerObserved: true,           // subagent was spawned: subagentInvocations > 0
    confidenceEvidence: {
      hasExplicitThreadId: false,
      hasExplicitAgentRole: false,
      hasSubagentTrace: true,       // invocation trace is sufficient evidence
    },
    workerCompletionClaimed: true,
    workerValidationObserved: true,
    workerValidationVerified: true,
    workerValidationFresh: true,
    workerValidationActor: "WORKER",
    workerValidationExitCode: 0,
    acceptanceObserved: true,
    acceptanceActor: "ORCHESTRATOR",
    acceptanceState: "ACCEPTED",
  });

  assert.equal(result.fidelityStatus, "PASS", "AGY child-conversation pattern must yield FIDELITY_PASS");
  assert.equal(result.writeActorValid, true);
  assert.equal(result.observed.productMutationActor, "WORKER_PROXY", "Actor must be WORKER_PROXY when events empty but worker present");
  assert.equal(result.confidence, "MEDIUM", "WORKER_PROXY confidence is capped at MEDIUM");
  assert.equal(result.observed.mutation_attribution_mode, "PROXY");
  assert.equal(result.violations.length, 0, "Zero violations expected for normal delegation");
  assert.equal(result.observed.delegation, true);
  assert.equal(result.observed.worker, "flash-low-worker");
});

test("fidelity: negative regression 12: child transcript factual attribution yields FACTUAL and HIGH confidence", () => {
  const result = evaluateTaskFidelity({
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 1,
    mutationActor: "WORKER",
    mutationEvents: [
      {
        path: "src/formatter.js",
        actor: "WORKER",
        actorRole: "WORKER",
        actorId: "child-worker-conv",
        confidence: "HIGH",
        evidenceSource: "CHILD_TRANSCRIPT",
      },
      {
        path: "test/formatter.test.js",
        actor: "WORKER",
        actorRole: "WORKER",
        actorId: "child-worker-conv",
        confidence: "HIGH",
        evidenceSource: "CHILD_TRANSCRIPT",
      },
    ],
    orchestratorWorkspaceWrites: 0,
    unknownWorkspaceWrites: 0,
    controlPlaneWrites: 3,
    dryRun: false,
    runtimeLoaded: true,
    orchestratorIdentity: "flash-orchestrator",
    workerObserved: true,
    confidenceEvidence: {
      hasExplicitThreadId: true,
      hasExplicitAgentRole: true,
      hasSubagentTrace: true,
    },
    workerCompletionClaimed: true,
    workerValidationObserved: true,
    workerValidationVerified: true,
    workerValidationExecutionId: "exec-valid-12",
    workerValidationConversationId: "child-worker-conv",
    workerValidationActor: "WORKER",
    workerValidationExitCode: 0,
    workerValidationFresh: true,
    acceptanceObserved: true,
    acceptanceActor: "ORCHESTRATOR",
    acceptanceState: "ACCEPTED",
    mutationAttributionMode: "FACTUAL",
  });

  assert.equal(result.fidelityStatus, "PASS");
  assert.equal(result.writeActorValid, true);
  assert.equal(result.observed.productMutationActor, "WORKER");
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.observed.mutation_attribution_mode, "FACTUAL");
  assert.equal(result.observed.worker_validation_verified, true);
  assert.equal(result.observed.worker_validation_fresh, true);
  assert.equal(result.observed.worker_validation_execution_id, "exec-valid-12");
  assert.equal(result.observed.worker_validation_conversation_id, "child-worker-conv");
  assert.equal(result.violations.length, 0);
});

test("regression 8: child transcript without explicit exit code yields exitCode=null and verified=false", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "child-transcript-reg-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "USER_INPUT", content: "Implement the feature" }),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: { CommandLine: "npm test" },
          },
        ],
      }),
      JSON.stringify({
        type: "TOOL_RESULT",
        content: "Running tests...\nAll suites queued", // No exit code output
      }),
    ];
    writeFileSync(transcriptPath, lines.join("\n"), "utf8");

    const sub = {
      conversationId: "child-conv-no-exit",
      subagentDescriptor: { typeName: "flash-low-worker", role: "Worker" },
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir);
    assert.equal(ev.validations.length, 1);
    assert.equal(ev.validations[0].command, "npm test");
    assert.equal(ev.validations[0].exitCode, null, "Exit code must be null when no explicit tool result exit code is present");
    assert.equal(ev.validations[0].actorRole, "WORKER");

    // Evaluate fidelity with this evidence:
    const fidelity = evaluateTaskFidelity({
      taskKey: "simple",
      runtime: "antigravity",
      subagentInvocations: 1,
      mutationActor: "WORKER",
      mutationEvents: [{ path: "src/formatter.js", actorRole: "WORKER", confidence: "HIGH" }],
      orchestratorWorkspaceWrites: 0,
      unknownWorkspaceWrites: 0,
      workerObserved: true,
      confidenceEvidence: { hasExplicitAgentRole: true },
      workerCompletionClaimed: true,
      workerValidationObserved: ev.validations.length > 0,
      workerValidationVerified: false,
      workerValidationFresh: false,
      workerValidationActor: ev.validations[0].actorRole,
      workerValidationExitCode: ev.validations[0].exitCode,
    });

    assert.equal(fidelity.fidelityStatus, "FAIL");
    assert.equal(fidelity.observed.worker_validation_observed, true);
    assert.equal(fidelity.observed.worker_validation_exit_code, null);
    assert.equal(fidelity.observed.worker_validation_verified, false);
    assert.ok(fidelity.violations.includes("WORKER_VALIDATION_FAILED"));
    assert.ok(fidelity.violations.includes("WORKER_VALIDATION_NOT_VERIFIED"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("regression 9: explicit success output (The command exited with code 0) yields exitCode=0 and eligible for verified success", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "child-transcript-succ-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "write_to_file",
            args: { TargetFile: join(tempDir, "src/formatter.js") },
          },
        ],
      }),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: { CommandLine: "npm test" },
          },
        ],
      }),
      JSON.stringify({
        type: "TOOL_RESULT",
        content: "The command exited with code 0.\nOutput:\n✔ tests passed",
      }),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "send_message",
            args: { Message: "IMPLEMENTATION_COMPLETE: Finished" },
          },
        ],
      }),
    ];
    writeFileSync(transcriptPath, lines.join("\n"), "utf8");

    const sub = {
      conversationId: "child-conv-success",
      subagentDescriptor: { typeName: "flash-low-worker", role: "Worker" },
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir);
    assert.equal(ev.validations.length, 1);
    assert.equal(ev.validations[0].exitCode, 0);
    assert.equal(ev.completionClaimed, true);

    const fidelity = evaluateTaskFidelity({
      taskKey: "simple",
      runtime: "antigravity",
      subagentInvocations: 1,
      mutationActor: "WORKER",
      mutationEvents: ev.mutations,
      orchestratorWorkspaceWrites: 0,
      unknownWorkspaceWrites: 0,
      workerObserved: true,
      confidenceEvidence: { hasExplicitAgentRole: true },
      workerCompletionClaimed: ev.completionClaimed,
      workerValidationObserved: true,
      workerValidationVerified: true,
      workerValidationFresh: true,
      workerValidationActor: "WORKER",
      workerValidationExitCode: ev.validations[0].exitCode,
      acceptanceObserved: true,
      acceptanceActor: "ORCHESTRATOR",
      acceptanceState: "ACCEPTED",
    });

    assert.equal(fidelity.fidelityStatus, "PASS");
    assert.equal(fidelity.observed.worker_validation_exit_code, 0);
    assert.equal(fidelity.observed.worker_validation_verified, true);
    assert.equal(fidelity.violations.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("regression 10: explicit failure output (The command exited with code 1) yields exitCode=1 and fidelity FAIL", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "child-transcript-fail-"));
  try {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: { CommandLine: "npm test" },
          },
        ],
      }),
      JSON.stringify({
        type: "TOOL_RESULT",
        content: "The command exited with code 1.\nOutput:\n✖ 1 test failed",
      }),
    ];
    writeFileSync(transcriptPath, lines.join("\n"), "utf8");

    const sub = {
      conversationId: "child-conv-fail",
      subagentDescriptor: { typeName: "flash-low-worker", role: "Worker" },
    };

    const ev = extractChildTranscriptEvidence(transcriptPath, sub, tempDir);
    assert.equal(ev.validations.length, 1);
    assert.equal(ev.validations[0].exitCode, 1);

    const fidelity = evaluateTaskFidelity({
      taskKey: "simple",
      runtime: "antigravity",
      subagentInvocations: 1,
      mutationActor: "WORKER",
      mutationEvents: [{ path: "src/formatter.js", actorRole: "WORKER", confidence: "HIGH" }],
      orchestratorWorkspaceWrites: 0,
      unknownWorkspaceWrites: 0,
      workerObserved: true,
      confidenceEvidence: { hasExplicitAgentRole: true },
      workerCompletionClaimed: true,
      workerValidationObserved: true,
      workerValidationVerified: false,
      workerValidationFresh: false,
      workerValidationActor: "WORKER",
      workerValidationExitCode: 1,
    });

    assert.equal(fidelity.fidelityStatus, "FAIL");
    assert.equal(fidelity.observed.worker_validation_exit_code, 1);
    assert.equal(fidelity.observed.worker_validation_verified, false);
    assert.ok(fidelity.violations.includes("WORKER_VALIDATION_FAILED"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("regression 11: subagent invocation count: 1 worker => 1 invocation, 2 reviewers => 2 invocations without double count", () => {
  const runtimeRoot = resolve(orchestraRoot, "runtimes/antigravity");
  const preToolScript = resolve(runtimeRoot, ".agents/hooks/pre-tool-enforce.mjs");
  const postToolScript = resolve(runtimeRoot, ".agents/hooks/post-tool-telemetry.mjs");

  const clean = () => {
    process.chdir(runtimeRoot);
    try { unlinkSync(".agents/state/active-state.json"); } catch {}
    try { unlinkSync(".agents/state/role-bindings.json"); } catch {}
    try { unlinkSync(".agents/telemetry/events.jsonl"); } catch {}
  };

  // Case A: 1 invoke_subagent with 1 worker
  clean();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    const workerCall = {
      name: "invoke_subagent",
      args: {
        Subagents: [
          { TypeName: "flash-low-worker", Role: "Worker", Prompt: "Fix bug" },
        ],
      },
    };

    // Run pre-tool hook then post-tool hook (the full cycle)
    execFileSync("node", [preToolScript], {
      input: JSON.stringify({ conversationId: "parent-c1", toolCall: workerCall }),
    });
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({ conversationId: "parent-c1", toolName: "invoke_subagent", toolCall: workerCall }),
    });

    const stateA = JSON.parse(readFileSync(".agents/state/active-state.json", "utf8"));
    assert.equal(stateA.invoke_subagent_calls, 1);
    assert.equal(stateA.subagent_invocations, 1, "1 worker delegation must yield subagent_invocations = 1");
    assert.equal(stateA.worker_invocations, 1);
    assert.equal(stateA.reviewer_invocations || 0, 0);
  } finally {
    clean();
  }

  // Case B: 1 invoke_subagent with 2 reviewers
  clean();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({ activeRole: "ORCHESTRATOR" }));

    const reviewerCall = {
      name: "invoke_subagent",
      args: {
        Subagents: [
          { TypeName: "flash-reviewer", Role: "Two-Key Reviewer 1", Prompt: "Review key 1" },
          { TypeName: "flash-reviewer", Role: "Two-Key Reviewer 2", Prompt: "Review key 2" },
        ],
      },
    };

    execFileSync("node", [preToolScript], {
      input: JSON.stringify({ conversationId: "parent-c2", toolCall: reviewerCall }),
    });
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({ conversationId: "parent-c2", toolName: "invoke_subagent", toolCall: reviewerCall }),
    });

    const stateB = JSON.parse(readFileSync(".agents/state/active-state.json", "utf8"));
    assert.equal(stateB.invoke_subagent_calls, 1);
    assert.equal(stateB.subagent_invocations, 2, "2 reviewers in 1 invoke_subagent call must yield subagent_invocations = 2");
    assert.equal(stateB.reviewer_invocations, 2);
    assert.equal(stateB.worker_invocations || 0, 0);
  } finally {
    clean();
  }
});

test("regression 12: fidelity negative tests: missing verification, null exitCode, orchestrator validator, stale validation fail closed; valid passes", () => {
  const baseValid = {
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 1,
    mutationActor: "WORKER",
    mutationEvents: [
      {
        path: "src/formatter.js",
        actorRole: "WORKER",
        actorId: "child-worker-conv",
        agentProfile: "flash-low-worker",
        confidence: "HIGH",
        evidenceSource: "CHILD_TRANSCRIPT",
      },
    ],
    orchestratorWorkspaceWrites: 0,
    unknownWorkspaceWrites: 0,
    controlPlaneWrites: 2,
    runtimeLoaded: true,
    orchestratorIdentity: "flash-orchestrator",
    workerObserved: true,
    confidenceEvidence: { hasExplicitAgentRole: true },
    workerCompletionClaimed: true,
    workerValidationObserved: true,
    workerValidationVerified: true,
    workerValidationFresh: true,
    workerValidationActor: "WORKER",
    workerValidationExitCode: 0,
    acceptanceObserved: true,
    acceptanceActor: "ORCHESTRATOR",
    acceptanceState: "ACCEPTED",
    mutationAttributionMode: "FACTUAL",
  };

  // Case 1: Worker exists + mutations factual but validationVerified=false => FAIL
  const res1 = evaluateTaskFidelity({
    ...baseValid,
    workerValidationVerified: false,
  });
  assert.equal(res1.fidelityStatus, "FAIL");
  assert.ok(res1.violations.includes("WORKER_VALIDATION_NOT_VERIFIED"));

  // Case 2: Worker validation exitCode=null => FAIL
  const res2 = evaluateTaskFidelity({
    ...baseValid,
    workerValidationExitCode: null,
    workerValidationVerified: false,
  });
  assert.equal(res2.fidelityStatus, "FAIL");
  assert.ok(res2.violations.includes("WORKER_VALIDATION_FAILED"));

  // Case 3: workerValidationActor=ORCHESTRATOR => FAIL
  const res3 = evaluateTaskFidelity({
    ...baseValid,
    workerValidationActor: "ORCHESTRATOR",
  });
  assert.equal(res3.fidelityStatus, "FAIL");
  assert.ok(res3.violations.includes("WORKER_VALIDATION_INVALID_ACTOR"));

  // Case 4: workerValidationFresh=false => FAIL
  const res4 = evaluateTaskFidelity({
    ...baseValid,
    workerValidationFresh: false,
  });
  assert.equal(res4.fidelityStatus, "FAIL");
  assert.ok(res4.violations.includes("WORKER_VALIDATION_STALE"));

  // Case 5: All evidence valid => PASS
  const res5 = evaluateTaskFidelity(baseValid);
  assert.equal(res5.fidelityStatus, "PASS");
  assert.equal(res5.violations.length, 0);
  assert.equal(res5.observed.worker_validation_verified, true);
  assert.equal(res5.observed.worker_validation_fresh, true);
  assert.equal(res5.observed.worker_validation_actor, "WORKER");
  assert.equal(res5.observed.worker_validation_exit_code, 0);
  assert.equal(res5.observed.acceptance_observed, true);
  assert.equal(res5.observed.acceptance_actor, "ORCHESTRATOR");
  assert.equal(res5.observed.acceptance_state, "ACCEPTED");
});

test("regression 13: formal orchestrator acceptance gate enforcement (missing, self-acceptance, non-accepted state fail closed; valid passes)", () => {
  const baseValid = {
    taskKey: "simple",
    runtime: "antigravity",
    subagentInvocations: 1,
    mutationActor: "WORKER",
    mutationEvents: [
      {
        path: "src/formatter.js",
        actorRole: "WORKER",
        actorId: "child-worker-conv",
        agentProfile: "flash-low-worker",
        confidence: "HIGH",
        evidenceSource: "CHILD_TRANSCRIPT",
      },
    ],
    orchestratorWorkspaceWrites: 0,
    unknownWorkspaceWrites: 0,
    controlPlaneWrites: 2,
    runtimeLoaded: true,
    orchestratorIdentity: "flash-orchestrator",
    workerObserved: true,
    confidenceEvidence: { hasExplicitAgentRole: true },
    workerCompletionClaimed: true,
    workerValidationObserved: true,
    workerValidationVerified: true,
    workerValidationFresh: true,
    workerValidationActor: "WORKER",
    workerValidationExitCode: 0,
    acceptanceObserved: true,
    acceptanceActor: "ORCHESTRATOR",
    acceptanceState: "ACCEPTED",
    mutationAttributionMode: "FACTUAL",
  };

  // Case 1: acceptanceObserved === false => FAIL closed
  const res1 = evaluateTaskFidelity({
    ...baseValid,
    acceptanceObserved: false,
  });
  assert.equal(res1.fidelityStatus, "FAIL");
  assert.ok(res1.violations.includes("ORCHESTRATOR_ACCEPTANCE_NOT_OBSERVED"));

  // Case 2: worker self-acceptance (acceptanceActor === "WORKER") => FAIL closed
  const res2 = evaluateTaskFidelity({
    ...baseValid,
    acceptanceActor: "WORKER",
  });
  assert.equal(res2.fidelityStatus, "FAIL");
  assert.ok(res2.violations.includes("INVALID_ACCEPTANCE_ACTOR"));

  // Case 3: missing acceptance actor => FAIL closed
  const res3 = evaluateTaskFidelity({
    ...baseValid,
    acceptanceActor: null,
  });
  assert.equal(res3.fidelityStatus, "FAIL");
  assert.ok(res3.violations.includes("INVALID_ACCEPTANCE_ACTOR"));

  // Case 4: acceptanceState !== "ACCEPTED" (e.g. "PENDING") => FAIL closed
  const res4 = evaluateTaskFidelity({
    ...baseValid,
    acceptanceState: "PENDING",
  });
  assert.equal(res4.fidelityStatus, "FAIL");
  assert.ok(res4.violations.includes("IMPLEMENTATION_NOT_ACCEPTED"));

  // Case 5: Fully valid orchestrator acceptance => PASS
  const res5 = evaluateTaskFidelity(baseValid);
  assert.equal(res5.fidelityStatus, "PASS");
  assert.equal(res5.violations.length, 0);
  assert.equal(res5.observed.acceptance_observed, true);
  assert.equal(res5.observed.acceptance_actor, "ORCHESTRATOR");
  assert.equal(res5.observed.acceptance_state, "ACCEPTED");
});
