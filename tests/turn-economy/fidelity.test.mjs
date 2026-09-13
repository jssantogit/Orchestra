import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK_FIDELITY_REQUIREMENTS,
  EXPECTED_ROUTES,
  getExpectedRoute,
  classifyRoleAttributionConfidence,
  evaluateTaskFidelity,
} from "../../benchmarks/turn-economy/fidelity.mjs";
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
  });

  assert.equal(result.fidelityStatus, "PASS", "AGY child-conversation pattern must yield FIDELITY_PASS");
  assert.equal(result.writeActorValid, true);
  assert.equal(result.observed.productMutationActor, "WORKER_PROXY", "Actor must be WORKER_PROXY when events empty but worker present");
  assert.equal(result.confidence, "HIGH", "Subagent trace gives HIGH confidence");
  assert.equal(result.violations.length, 0, "Zero violations expected for normal delegation");
  assert.equal(result.observed.delegation, true);
  assert.equal(result.observed.worker, "flash-low-worker");
});
