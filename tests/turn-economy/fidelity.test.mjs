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
