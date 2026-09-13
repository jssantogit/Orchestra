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

  const agySimpleRoute = getExpectedRoute("simple", "antigravity");
  assert.equal(agySimpleRoute.orchestrator, "flash-orchestrator");
  assert.equal(agySimpleRoute.worker, "flash-worker");
  assert.equal(agySimpleRoute.delegationExpected, true);
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
