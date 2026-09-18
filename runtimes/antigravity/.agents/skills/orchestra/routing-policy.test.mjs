import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  TASK_DOMAINS,
  GEMINI_MODELS,
  ANTIGRAVITY_MODELS,
  FORBIDDEN_MODELS,
  STATE_NAMES,
  VALID_TRANSITIONS,
  validateStateTransition,
  createAstraEscalationPacket,
  createUnresolvedDecisionPacket,
  createAcceptanceGate,
  createCrossDomainRequest,
  createIntegrationContract,
  createImplementationHandoff,
  createIndependentReviewPacket,
  createTwoKeyReviewPacket,
  evaluateTwoKeyReview,
  validateAcceptanceEligibility,
  createRetryBudget,
  createScopeContract,
  createStateSnapshot,
  createTelemetryEvent,
  decideRoute,
  directWriteDecision,
  consumeRetryBudget,
  normalizeCriticality,
  normalizeTaskDomain,
  normalizeTaskAction,
  reviewRoute,
  requiresIntegration,
  summarizePolicyDrift,
  validateScopeContract,
  PROGRESSIVE_TEST_STAGES,
  RETRY_REASONS,
  decideAntigravityRoute,
  reviewAntigravityRoute,
  getProgressiveTestStage,
  createDeltaRetryPacket,
  createOpusReviewPacket,
  detectCoordinationOverhead,
  detectContextBloat,
  checkLoopCircuitBreakers,
  calculateEfficiencyMetrics,
  formatTestResultSummary,
  CIRCUIT_BREAKER_THRESHOLDS,
  extractRealShellRedirections,
  classifyExecutionEvidence,
  isHeavyExecution,
  createHeavyExecutionHandoff,
  createDisposableWorkerPacket,
  validateDisposableWorkerResult,
  checkPollingBudget,
  calculateContextAmplification,
  detectHookFriction,
  TOOL_OUTPUT_LIMITS,
  POLLING_POLICY,
  SHELL_INTENTS,
  TOOL_POLICY_THRESHOLDS,
  classifyShellIntent,
  createInitialToolMix,
  calculateToolMixMetrics,
  detectShellOveruse,
  detectExplorationOverhead,
  createMutationRecord,
  recordMutation,
  isPathDocsOrSpec,
  isPathCore,
  isPathApp,
  checkEvidenceFreshness,
  findReusableEvidence,
  verifyWorkerValidation,
  recordNativeToolFallback,
  WORKER_PACKET_LIMITS,
  validateWorkerPacket,
  calculateViewTargetWindow,
  classifyShellMutation,
  trackGitInspection,
  createAdvisory,
  deliverPendingAdvisories,
  consumeDeliveredAdvisories,
  planVerificationBatch,
  DIRECT_ACTION_TYPES,
  normalizeDirectActionType,
  classifyDirectActionIntent,
  GIT_EFFECT_TAXONOMY,
  classifyGitEffect,
  detectDirectActionOverhead,
  detectDirectActionOverthinking,
} from "./routing-policy.mjs";
import {
  deriveAvailableActions,
  deriveDecisionState,
  classifyBaselineDecision,
} from "../../dream/action-space.mjs";
import { evaluatePolicy } from "../../dream/policy-engine.mjs";

const staticPolicyPath = new URL("../../dream/policies/static-policy-v1.json", import.meta.url);
const staticPolicy = JSON.parse(readFileSync(staticPolicyPath, "utf-8"));

test("D: routes normal product implementation to Flash Medium worker", () => {
  const res = decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "normal" });
  assert.equal(res.kind, "worker");
  assert.equal(res.model, GEMINI_MODELS.WORKER_MEDIUM);
  assert.equal(res.effort, "medium");
});

test("D2: routes trivial and mechanical changes to Flash Low worker", () => {
  const trivialRes = decideRoute({ taskClass: "trivial-change" });
  assert.equal(trivialRes.kind, "worker");
  assert.equal(trivialRes.model, GEMINI_MODELS.WORKER_LOW);
  assert.equal(trivialRes.effort, "low");

  const mechRes = decideRoute({ taskAction: "MECHANICAL_FIX" });
  assert.equal(mechRes.kind, "worker");
  assert.equal(mechRes.model, GEMINI_MODELS.WORKER_LOW);
  assert.equal(mechRes.effort, "low");

  const docsRes = decideRoute({ taskAction: "IMPLEMENT", taskDomain: "DOCS" });
  assert.equal(docsRes.kind, "worker");
  assert.equal(docsRes.model, GEMINI_MODELS.WORKER_LOW);
  assert.equal(docsRes.effort, "low");
});

test("uses Gemini Flash Medium as default control-plane orchestrator baseline", () => {
  const res = decideRoute({});
  assert.equal(res.kind, "orchestration");
  assert.equal(res.model, GEMINI_MODELS.ORCHESTRATOR);
  assert.equal(res.effort, "medium");
});

test("E: routes AutoEQ deep technical investigation to Flash High specialist", () => {
  const res = decideRoute({ taskClass: "deep-technical-investigation" });
  assert.equal(res.kind, "orchestration");
  assert.equal(res.model, GEMINI_MODELS.INVESTIGATOR);
  assert.equal(res.effort, "high");
});

test("routes hard, specified implementation to Flash High", () => {
  const res = decideRoute({ taskClass: "hard-specified-implementation" });
  assert.equal(res.kind, "worker");
  assert.equal(res.model, GEMINI_MODELS.WORKER_HIGH);
  assert.equal(res.effort, "high");
});

test("uses deterministic recovery for a lint failure", () => {
  assert.deepEqual(
    decideRoute({ objectiveGate: "lint-failure" }),
    { kind: "deterministic", action: "bounded-fix-retry", reason: "lint-failure" },
  );
});

test("H: completes normal review when objective acceptance passes", () => {
  assert.deepEqual(
    reviewRoute({ acceptanceCriteriaStatus: "passed" }),
    { kind: "done", reason: "acceptance-passed" },
  );
});

test("escalates conflicting architectural evidence to Flash High investigator", () => {
  const res = reviewRoute({ evidence: "conflicting", architecturalImpact: true });
  assert.equal(res.kind, "orchestration");
  assert.equal(res.model, GEMINI_MODELS.INVESTIGATOR);
  assert.equal(res.effort, "high");
});

test("returns from Flash High investigation to Flash Medium for settled execution", () => {
  const res = reviewRoute({ priorModel: GEMINI_MODELS.INVESTIGATOR, priorEffort: "high", decisionResolved: true, nextTaskClass: "conventional-implementation" });
  assert.equal(res.kind, "worker");
  assert.equal(res.model, GEMINI_MODELS.WORKER_MEDIUM);
  assert.equal(res.effort, "medium");
});

test("P: strictly forbids Claude, Sonnet, Opus, GPT, or Gemini 3.1 Pro across all routes", () => {
  const decisions = [
    decideRoute({}),
    decideRoute({ taskAction: "ORCHESTRATE" }),
    decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "normal" }),
    decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "simple" }),
    decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "difficult" }),
    decideRoute({ taskAction: "INVESTIGATE" }),
    decideRoute({ taskAction: "MECHANICAL_FIX" }),
    decideRoute({ taskAction: "TEST" }),
    decideRoute({ taskClass: "deep-technical-investigation" }),
    decideRoute({ taskClass: "trivial-change" }),
    decideRoute({ taskClass: "conventional-implementation" }),
    reviewRoute({ acceptanceCriteriaStatus: "passed" }),
    reviewRoute({ evidence: "conflicting", architecturalImpact: true }),
    reviewRoute({ deepInvestigationComplete: true, decisionResolved: false }),
  ];

  for (const decision of decisions) {
    if (decision.model) {
      assert(!FORBIDDEN_MODELS.includes(decision.model), `Forbidden model ${decision.model} detected!`);
      assert(decision.model.startsWith("gemini-3.8-flash"), `Non-Gemini-Flash model ${decision.model} detected!`);
    }
  }
});

test("O: state machine validates allowed transitions and fails closed on invalid transitions", () => {
  assert.equal(validateStateTransition("INTAKE", "CLASSIFIED").valid, true);
  assert.equal(validateStateTransition("CLASSIFIED", "PLANNED").valid, true);
  assert.equal(validateStateTransition("PLANNED", "DELEGATED").valid, true);
  assert.equal(validateStateTransition("DELEGATED", "EXECUTING").valid, true);
  assert.equal(validateStateTransition("EXECUTING", "EVIDENCE_READY").valid, true);
  assert.equal(validateStateTransition("EVIDENCE_READY", "ACCEPTANCE").valid, true);
  assert.equal(validateStateTransition("ACCEPTANCE", "DONE").valid, true);
  assert.equal(validateStateTransition("ACCEPTANCE", "CRITICAL_REVIEW").valid, true);
  assert.equal(validateStateTransition("ACCEPTANCE", "HUMAN_GATE").valid, true);

  // Invalid transitions must fail closed
  const invalid1 = validateStateTransition("INTAKE", "DONE");
  assert.equal(invalid1.valid, false);
  assert.equal(invalid1.error, "INVALID_TRANSITION");

  const invalid2 = validateStateTransition("EXECUTING", "DONE");
  assert.equal(invalid2.valid, false);
  assert.equal(invalid2.error, "INVALID_TRANSITION");

  const invalid3 = validateStateTransition("UNKNOWN_STATE", "INTAKE");
  assert.equal(invalid3.valid, false);
  assert.equal(invalid3.error, "INVALID_TRANSITION");
});

test("F: worker leaving domain triggers CROSS_DOMAIN_REQUEST and returns to Orchestrator", () => {
  const req = createCrossDomainRequest({
    currentDomain: "UI",
    requiredDomain: "DSP_CORE",
    reason: "Missing normalized magnitude response helper in core",
    requestedCapability: "Export getNormalizedResponse from @autoeq-workbench/core",
    evidence: "UI chart component cannot render raw arrays",
    blocking: true,
  });

  assert.equal(req.type, "CROSS_DOMAIN_REQUEST");
  assert.equal(req.currentDomain, "UI");
  assert.equal(req.requiredDomain, "DSP_CORE");
  assert.equal(req.blocking, true);

  const route = reviewRoute({ crossDomainRequest: req });
  assert.equal(route.kind, "orchestration");
  assert.equal(route.model, GEMINI_MODELS.ORCHESTRATOR);
  assert.equal(route.reason, "cross-domain-request");
});

test("G: worker declaring tests passed without evidence in ledger is EVIDENCE_INCOMPLETE", () => {
  const facts = {
    acceptanceCriteriaStatus: "passed",
    testsRequired: ["pnpm test"],
    evidenceLedger: [], // empty ledger!
  };

  const check = validateAcceptanceEligibility(facts);
  assert.equal(check.eligible, false);
  assert.equal(check.status, "EVIDENCE_INCOMPLETE");
  assert(check.reasons.some(r => r.includes("no objective TEST_RUN recorded")));
});

test("H: normal task with complete evidence is ACCEPTANCE_ELIGIBLE and fast-path accepted", () => {
  const facts = {
    acceptanceCriteriaStatus: "passed",
    criteriaStatus: "passed",
    testsRequired: ["pnpm test"],
    evidenceLedger: [
      { type: "TEST_RUN", command: "pnpm test", exitCode: 0, passed: 10, failed: 0 }
    ],
    scopeContract: {
      allowedPaths: ["packages/core/**"],
      forbiddenPaths: [],
    },
    changedPaths: ["packages/core/src/calc.ts"]
  };

  const check = validateAcceptanceEligibility(facts);
  assert.equal(check.eligible, true);
  assert.equal(check.status, "ACCEPTANCE_ELIGIBLE");

  const review = reviewRoute(facts);
  assert.equal(review.kind, "done");
  assert.equal(review.reason, "acceptance-passed");
});

test("H2: acceptance does not accept evidence from wrong package scope", () => {
  const facts = {
    acceptanceCriteriaStatus: "passed",
    criteriaStatus: "passed",
    testsRequired: ["pnpm --filter @autoeq-workbench/app test"],
    evidenceLedger: [
      {
        type: "TEST_RUN",
        command: "pnpm --filter @autoeq-workbench/core test",
        scope: "@autoeq-workbench/core",
        exitCode: 0,
        passed: 10,
        failed: 0,
      }
    ],
    scopeContract: {
      allowedPaths: ["apps/web/**"],
      forbiddenPaths: [],
    },
    changedPaths: ["apps/web/src/App.tsx"]
  };

  const check = validateAcceptanceEligibility(facts);
  assert.equal(check.eligible, false);
  assert.equal(check.status, "EVIDENCE_INCOMPLETE");
  assert(check.reasons.some(r => r.includes("no matching TEST_RUN")));
});

test("I: partial result dispatches bounded delta retry", () => {
  const facts = {
    taskAction: "IMPLEMENT",
    workerResult: "PARTIAL",
    workerCompleted: false,
    retryBudget: { maxAttempts: 2, attempt: 0, remainingAttempts: 2 },
    retryReason: "INCOMPLETE_IMPLEMENTATION",
  };

  const res = reviewRoute(facts);
  assert.equal(res.kind, "worker");
  assert.equal(res.retry, true);
  assert.equal(res.retryBudget.attempt, 1);
  assert.equal(res.retryBudget.remainingAttempts, 1);
});

test("J: retry budget exhausted halts to HUMAN_GATE", () => {
  const facts = {
    taskAction: "IMPLEMENT",
    workerResult: "PARTIAL",
    workerCompleted: false,
    retryBudget: { maxAttempts: 2, attempt: 2, remainingAttempts: 0 },
  };

  const res = reviewRoute(facts);
  assert.equal(res.state, "HUMAN_GATE");
  assert.equal(res.humanGate, true);
  assert.equal(res.reason, "retry-budget-exhausted");
});

test("K: CRITICAL change routes to Two-Key review with Flash High reviewers", () => {
  const facts = {
    criticality: "CRITICAL",
    acceptanceCriteriaStatus: "passed",
  };

  const res = reviewRoute(facts);
  assert.equal(res.kind, "two-key-review");
  assert.equal(res.modelReviewerA, GEMINI_MODELS.REVIEWER_A);
  assert.equal(res.modelReviewerB, GEMINI_MODELS.REVIEWER_B);
  assert.equal(res.criticality, "CRITICAL");
});

test("K2: Two-Key review where both reviewers ACCEPT results in ACCEPT", () => {
  const evaluation = evaluateTwoKeyReview({}, "ACCEPT", "ACCEPT");
  assert.equal(evaluation.acceptable, true);
  assert.equal(evaluation.decision, "ACCEPT");
  assert.equal(evaluation.nextState, "DONE");
});

test("L: Two-Key review disagreement halts immediately to HUMAN_GATE", () => {
  const evaluation = evaluateTwoKeyReview({}, "ACCEPT", "CHANGES_REQUIRED");
  assert.equal(evaluation.acceptable, false);
  assert.equal(evaluation.decision, "DISAGREEMENT");
  assert.equal(evaluation.nextState, "HUMAN_GATE");
  assert.equal(evaluation.humanGateRequired, true);

  const routeRes = reviewRoute({
    reviewerAVerdict: "ACCEPT",
    reviewerBVerdict: "CHANGES_REQUIRED",
  });
  assert.equal(routeRes.state, "HUMAN_GATE");
  assert.equal(routeRes.humanGate, true);
  assert(routeRes.reason.includes("Two-Key review disagreement"));
});

test("M: repeated tool/file loop trips circuit breaker", () => {
  const history = [
    { tool: "view_file", path: "packages/core/src/dsp.ts", state: "EXECUTING" },
    { tool: "view_file", path: "packages/core/src/dsp.ts", state: "EXECUTING" },
    { tool: "view_file", path: "packages/core/src/dsp.ts", state: "EXECUTING" },
    { tool: "view_file", path: "packages/core/src/dsp.ts", state: "EXECUTING" },
  ];

  const loopCheck = checkLoopCircuitBreakers(history, "EXECUTING", { maxFileReads: 4 });
  assert.equal(loopCheck.tripped, true);
  assert.equal(loopCheck.type, "LOOP_SUSPECTED");

  const stalledHistory = [
    { tool: "run_command", target: "git status" },
    { tool: "run_command", target: "git status" },
    { tool: "run_command", target: "git status" },
  ];
  const stallCheck = checkLoopCircuitBreakers(stalledHistory, "EXECUTING", { maxSameTools: 3 });
  assert.equal(stallCheck.tripped, true);
  assert.equal(stallCheck.type, "STALLED");
});

test("N: acceptance satisfied results in early stop", () => {
  const res = reviewRoute({ acceptanceCriteriaStatus: "passed", criticality: "NORMAL" });
  assert.equal(res.kind, "done");
  assert.equal(res.reason, "acceptance-passed");
});

test("creates structured delta retry packet", () => {
  const packet = createDeltaRetryPacket({
    failedOrMissing: "Missing null check for undefined curve",
    newEvidence: "TypeError: Cannot read properties of undefined",
    requiredCorrection: "Add optional chaining before accessing magnitude",
    retryReason: "FAILED_TEST",
    retryBudget: { maxAttempts: 2, attempt: 0, remainingAttempts: 2 },
  });

  assert.equal(packet.type, "DELTA_RETRY");
  assert.equal(packet.basePlan, "unchanged");
  assert.equal(packet.retryReason, "FAILED_TEST");
  assert.equal(packet.attempt, 1);
  assert.equal(packet.remainingAttempts, 1);
});

test("detects coordination overhead and context bloat", () => {
  const overhead = detectCoordinationOverhead({ attempt: 4, totalCalls: 10 });
  assert.equal(overhead.detected, true);
  assert.equal(overhead.diagnostic, "COORDINATION_OVERHEAD");

  const bloat = detectContextBloat("x".repeat(15000));
  assert.equal(bloat.detected, true);
  assert.equal(bloat.diagnostic, "CONTEXT_BLOAT");
});

test("calculates efficiency metrics", () => {
  const events = [
    { task_action: "ORCHESTRATE", routing_decision: "orchestration" },
    { task_action: "IMPLEMENT", routing_decision: "worker", retry: false, acceptance_result: "ACCEPTED", attempt_number: 1 },
    { task_action: "REVIEW", routing_decision: "orchestration" },
  ];

  const metrics = calculateEfficiencyMetrics(events);
  assert.equal(metrics.total_model_calls, 3);
  assert.equal(metrics.orchestrator_calls, 2);
  assert.equal(metrics.worker_calls, 1);
  assert.equal(metrics.accepted_tasks, 1);
  assert.equal(metrics.first_pass_acceptance_rate, 1);
});

test("JSON CLI provides deterministic routing output", () => {
  const policyScript = fileURLToPath(new URL("./routing-policy.mjs", import.meta.url));
  const output = execFileSync(
    process.execPath,
    [policyScript, "--json"],
    { input: '{"taskAction":"IMPLEMENT","taskDomain":"DOCS"}' },
  );

  const parsed = JSON.parse(output);
  assert.equal(parsed.kind, "worker");
  assert.equal(parsed.model, GEMINI_MODELS.WORKER_LOW);
});

test("shell scanner: accurately identifies real redirections vs JS/Markdown/comparisons/arithmetic/heredocs", () => {
  // Real redirections: DETECT
  const r1 = extractRealShellRedirections("echo foo > file");
  assert.equal(r1.hasRedirection, true);
  assert.deepEqual(r1.targets, ["file"]);

  const r2 = extractRealShellRedirections("echo foo >> file");
  assert.equal(r2.hasRedirection, true);
  assert.deepEqual(r2.targets, ["file"]);

  const r3 = extractRealShellRedirections("cmd 1>out");
  assert.equal(r3.hasRedirection, true);
  assert.deepEqual(r3.targets, ["out"]);

  const r4 = extractRealShellRedirections("cmd 2>err");
  assert.equal(r4.hasRedirection, true);
  assert.deepEqual(r4.targets, ["err"]);

  const r5 = extractRealShellRedirections("cmd 1>>out");
  assert.equal(r5.hasRedirection, true);
  assert.deepEqual(r5.targets, ["out"]);

  const r6 = extractRealShellRedirections("cmd 2>>err");
  assert.equal(r6.hasRedirection, true);
  assert.deepEqual(r6.targets, ["err"]);

  const r7 = extractRealShellRedirections("cmd &> out");
  assert.equal(r7.hasRedirection, true);
  assert.deepEqual(r7.targets, ["out"]);

  const r8 = extractRealShellRedirections('cmd >> "file with spaces.txt"');
  assert.equal(r8.hasRedirection, true);
  assert.deepEqual(r8.targets, ["file with spaces.txt"]);

  // Standard descriptor redirections to null/stdout
  const r9 = extractRealShellRedirections("echo foo > /dev/null 2>&1");
  assert.equal(r9.hasRedirection, true);
  assert.deepEqual(r9.targets, []);

  // NOT redirections: DO NOT DETECT AS OUTPUT WRITE
  const nr1 = extractRealShellRedirections('node -e "const f = (a, b) => a + b"');
  assert.equal(nr1.targets.length, 0);

  const nr2 = extractRealShellRedirections("node -e 'if (elapsed >= deadline) process.exit(0)'");
  assert.equal(nr2.targets.length, 0);

  const nr3 = extractRealShellRedirections("node -e 'if (x <= y) process.exit(0)'");
  assert.equal(nr3.targets.length, 0);

  const nr4 = extractRealShellRedirections("node -e 'console.log(8 >> 1)'");
  assert.equal(nr4.targets.length, 0);

  const nr5 = extractRealShellRedirections('node -e "console.log(8 >> 1)"');
  assert.equal(nr5.targets.length, 0);

  const nr6 = extractRealShellRedirections("echo $((8 >> 1))");
  assert.equal(nr6.targets.length, 0);

  const nr7 = extractRealShellRedirections('echo "$((8 >> 1))"');
  assert.equal(nr7.targets.length, 0);

  const nr8 = extractRealShellRedirections('echo "> markdown"');
  assert.equal(nr8.targets.length, 0);

  const nr9 = extractRealShellRedirections("echo '>> literal'");
  assert.equal(nr9.targets.length, 0);

  const nr10 = extractRealShellRedirections('cat <<< "hello"');
  assert.equal(nr10.targets.length, 0);

  const nr11 = extractRealShellRedirections("cat <<EOF\nx\nEOF");
  assert.equal(nr11.targets.length, 0);

  const nr12 = extractRealShellRedirections("cat <<-EOF\nx\nEOF");
  assert.equal(nr12.targets.length, 0);

  const nr13 = extractRealShellRedirections("echo foo \\> not_a_file");
  assert.equal(nr13.targets.length, 0);
});

test("evidence classifier: deterministic runtime facts classification", () => {
  const tc = classifyExecutionEvidence("pnpm typecheck", 0, "No errors found", 120);
  assert.equal(tc.type, "TYPECHECK");
  assert.equal(tc.exitCode, 0);
  assert.equal(tc.passed, 1);
  assert.equal(tc.failed, 0);

  const testPass = classifyExecutionEvidence("vitest run", 0, "Tests: 42 passed, 42 total", 800);
  assert.equal(testPass.type, "TEST_RUN");
  assert.equal(testPass.exitCode, 0);
  assert.equal(testPass.passed, 42);
  assert.equal(testPass.failed, 0);

  const testFail = classifyExecutionEvidence("pnpm test", 1, "FAIL: 2 failed, 10 passed", 1500);
  assert.equal(testFail.type, "TEST_RUN");
  assert.equal(testFail.exitCode, 1);
  assert.equal(testFail.passed, 10);
  assert.equal(testFail.failed, 2);

  const bld = classifyExecutionEvidence("pnpm build", 0, "Build completed", 3000);
  assert.equal(bld.type, "BUILD");
  assert.equal(bld.exitCode, 0);

  const lint = classifyExecutionEvidence("pnpm lint", 0, "Clean", 400);
  assert.equal(lint.type, "LINT");
  assert.equal(lint.exitCode, 0);

  const generic = classifyExecutionEvidence("ls -la", 0, "files...", 50);
  assert.equal(generic.type, "GENERIC_COMMAND_RESULT");
  assert.equal(generic.exitCode, 0);
});

test("heavy execution: routes to disposable worker with context firewall and compact contract", () => {
  assert.equal(isHeavyExecution({ taskAction: "HEAVY_EXECUTION" }), true);
  assert.equal(isHeavyExecution({ campaign: true }), true);
  assert.equal(isHeavyExecution({ benchmarkSuite: true }), true);
  assert.equal(isHeavyExecution({ taskAction: "IMPLEMENT" }), false);

  const route = decideRoute({ taskAction: "HEAVY_EXECUTION" });
  assert.equal(route.kind, "worker");
  assert.equal(route.model, GEMINI_MODELS.WORKER_HIGH);
  assert.equal(route.disposable, true);
  assert.equal(route.contextFirewall, true);

  const handoff = createHeavyExecutionHandoff({
    taskDomain: "AUTOEQ_ALGORITHM",
    goal: "Run 1000 curve optimization experiments",
  });
  assert.equal(handoff.disposable, true);
  assert.equal(handoff.contextFirewall, true);
  assert(Array.isArray(handoff.outputContract));

  const packet = createDisposableWorkerPacket({
    status: "COMPLETED",
    commandsRun: ["node run-campaign.mjs"],
    keyMetrics: { loss_mean: 0.12, loss_p95: 0.25 },
    topFindings: ["Parameter alpha=0.8 converged fastest"],
    artifactPaths: [".agents/artifacts/campaign-1000.json"],
  });
  const validation = validateDisposableWorkerResult(packet);
  assert.equal(validation.valid, true);
});

test("polling budget: enforces backoff intervals and max count", () => {
  const now = Date.now();
  // First poll -> allowed
  const r1 = checkPollingBudget({}, now);
  assert.equal(r1.allowed, true);
  assert.equal(r1.pollCount, 1);

  // Poll too fast (5s < 15s min backoff) -> denied
  const r2 = checkPollingBudget({ lastPollTimestamp: now - 5000, pollCount: 1 }, now);
  assert.equal(r2.allowed, false);
  assert.equal(r2.reason, "POLLING_TOO_FAST");

  // Valid interval (20s > 15s) -> allowed
  const r3 = checkPollingBudget({ lastPollTimestamp: now - 20000, pollCount: 1 }, now);
  assert.equal(r3.allowed, true);
  assert.equal(r3.pollCount, 2);

  // Exceeded budget (3 polls already) -> denied
  const r4 = checkPollingBudget({ lastPollTimestamp: now - 30000, pollCount: 3 }, now);
  assert.equal(r4.allowed, false);
  assert.equal(r4.reason, "POLLING_BUDGET_EXCEEDED");
});

test("context amplification and hook friction: accurate telemetry calculation", () => {
  const events = [
    { input_tokens: 1000, output_tokens: 200, tool_output_bytes: 5000, inline_tool_output_bytes: 5000 },
    { input_tokens: 2000, output_tokens: 300, tool_output_bytes: 70000, truncated_tool_output_bytes: 70000, artifact_output_bytes: 70000 },
    { input_tokens: 3000, output_tokens: 250, acceptance_result: "ACCEPTED" },
  ];

  const amp = calculateContextAmplification(events);
  assert.equal(amp.total_input_tokens, 6000);
  assert.equal(amp.total_tool_output_bytes, 75000);
  assert.equal(amp.truncated_tool_output_bytes, 70000);
  assert.equal(amp.accepted_tasks, 1);
  assert.equal(amp.context_reuse_amplification, 6000);

  const frictionEvents = [
    { decision: "deny", toolName: "run_command", deny_reason: "scope_error" },
    { decision: "deny", toolName: "run_command", deny_reason: "scope_error" },
    { decision: "deny", toolName: "run_command", deny_reason: "scope_error" },
    { decision: "allow", toolName: "run_command" },
  ];
  const friction = detectHookFriction(frictionEvents);
  assert.equal(friction.denied_count, 3);
  assert.equal(friction.max_consecutive_denies, 3);
  assert.equal(friction.hook_friction_detected, true);
  assert.equal(friction.status, "HOOK_FRICTION");
});

test("v3: shell classification classifies commands and avoidable intent accurately", () => {
  // cat file.ts -> SHELL_READ / avoidable
  const c1 = classifyShellIntent("cat file.ts");
  assert.equal(c1.category, SHELL_INTENTS.SHELL_READ);
  assert.equal(c1.avoidable, true);

  // sed -n '1,50p' file.ts -> SHELL_READ / avoidable
  const c2 = classifyShellIntent("sed -n '1,50p' file.ts");
  assert.equal(c2.category, SHELL_INTENTS.SHELL_READ);
  assert.equal(c2.avoidable, true);

  // rg Foo src/ -> SHELL_SEARCH / avoidable
  const c3 = classifyShellIntent("rg Foo src/");
  assert.equal(c3.category, SHELL_INTENTS.SHELL_SEARCH);
  assert.equal(c3.avoidable, true);

  // grep -R Foo src/ -> SHELL_SEARCH / avoidable
  const c4 = classifyShellIntent("grep -R Foo src/");
  assert.equal(c4.category, SHELL_INTENTS.SHELL_SEARCH);
  assert.equal(c4.avoidable, true);

  // find src -name '*.ts' -> SHELL_DISCOVERY / avoidable
  const c5 = classifyShellIntent("find src -name '*.ts'");
  assert.equal(c5.category, SHELL_INTENTS.SHELL_DISCOVERY);
  assert.equal(c5.avoidable, true);

  // sed -i 's/a/b/g' file.ts -> SHELL_EDIT / avoidable
  const c6 = classifyShellIntent("sed -i 's/foo/bar/g' packages/core/src/dsp.ts");
  assert.equal(c6.category, SHELL_INTENTS.SHELL_EDIT);
  assert.equal(c6.avoidable, true);

  // pnpm test -> SHELL_TEST / not avoidable
  const c7 = classifyShellIntent("pnpm test");
  assert.equal(c7.category, SHELL_INTENTS.SHELL_TEST);
  assert.equal(c7.avoidable, false);

  // pnpm typecheck -> SHELL_VALIDATION / not avoidable
  const c8 = classifyShellIntent("pnpm typecheck");
  assert.equal(c8.category, SHELL_INTENTS.SHELL_VALIDATION);
  assert.equal(c8.avoidable, false);

  // pnpm build -> SHELL_BUILD / not avoidable
  const c9 = classifyShellIntent("pnpm build");
  assert.equal(c9.category, SHELL_INTENTS.SHELL_BUILD);
  assert.equal(c9.avoidable, false);

  // node benchmark.mjs -> SHELL_HEAVY_EXECUTION / not avoidable
  const c10 = classifyShellIntent("node benchmark.mjs");
  assert.equal(c10.category, SHELL_INTENTS.SHELL_HEAVY_EXECUTION);
  assert.equal(c10.avoidable, false);
});

test("v3: native fallback records event and tracks fallback counter", () => {
  const state = { toolMix: createInitialToolMix() };
  const fallback = recordNativeToolFallback(state, {
    reason: "native_tool_failed",
    nativeTool: "grep_search",
    shellCommand: "grep -rn 'foo' src/",
  });
  assert.equal(fallback.type, "NATIVE_TOOL_FALLBACK");
  assert.equal(state.toolMix.native_tool_fallbacks, 1);
  assert.equal(state.toolFallbacks.length, 1);
});

test("v3: evidence freshness tracks mutations and scope invalidation", () => {
  // A. test PASS at mutationSeq 10, no relevant mutation -> FRESH
  const evA = {
    type: "TEST_RUN",
    scope: "@autoeq-workbench/core",
    command: "pnpm --filter @autoeq-workbench/core test",
    exitCode: 0,
    mutationSeq: 10,
  };
  const freshA = checkEvidenceFreshness(evA, 10, []);
  assert.equal(freshA.fresh, true);

  // B. test PASS at mutationSeq 10, relevant source edit at seq 11 -> STALE
  const mutationsB = [
    createMutationRecord(11, ["packages/core/src/dsp.ts"], "EDIT"),
  ];
  const freshB = checkEvidenceFreshness(evA, 11, mutationsB);
  assert.equal(freshB.fresh, false);
  assert.equal(freshB.staleReason, "CORE_MUTATION_INVALIDATION");

  // C. core test PASS at seq 10, docs-only mutation at seq 11 -> remains FRESH
  const mutationsC = [
    createMutationRecord(11, ["docs/superpowers/specs/filter-spec.md"], "EDIT"),
  ];
  const freshC = checkEvidenceFreshness(evA, 11, mutationsC);
  assert.equal(freshC.fresh, true);

  // D. app test PASS at seq 10, core change at seq 11 (known dependency) -> STALE
  const evD = {
    type: "TEST_RUN",
    scope: "apps/web",
    command: "pnpm --filter apps/web test",
    exitCode: 0,
    mutationSeq: 10,
  };
  const freshD = checkEvidenceFreshness(evD, 11, mutationsB);
  assert.equal(freshD.fresh, false);
  assert.equal(freshD.staleReason, "APP_DEPENDENCY_MUTATION_INVALIDATION");

  // E. dependency relation unknown -> conservative STALE
  const evE = {
    type: "CUSTOM_CHECK",
    scope: "UNKNOWN_SCOPE",
    command: "custom-checker",
    exitCode: 0,
    mutationSeq: 10,
  };
  const freshE = checkEvidenceFreshness(evE, 11, mutationsB);
  assert.equal(freshE.fresh, false);
  assert.equal(freshE.staleReason, "CONSERVATIVE_UNKNOWN_DEPENDENCY_STALE");
});

test("v3: no duplicate validation allows reuse of fresh evidence and invalidates upon mutation", () => {
  const evidenceLedger = [
    {
      type: "TEST_RUN",
      scope: "@autoeq-workbench/core",
      command: "pnpm --filter @autoeq-workbench/core test",
      exitCode: 0,
      mutationSeq: 5,
    },
    {
      type: "TYPECHECK",
      scope: "GLOBAL",
      command: "pnpm typecheck",
      exitCode: 0,
      mutationSeq: 5,
    },
  ];

  // 1. Without mutations, both are fresh and reusable
  const reuseTest = findReusableEvidence(
    evidenceLedger,
    "pnpm --filter @autoeq-workbench/core test",
    5,
    []
  );
  assert.equal(reuseTest.reusable, true);
  assert.equal(reuseTest.found, true);

  const reuseTypecheck = findReusableEvidence(
    evidenceLedger,
    "pnpm typecheck",
    5,
    []
  );
  assert.equal(reuseTypecheck.reusable, true);

  // 2. After relevant core edit, core test and global typecheck become stale
  const mutations = [
    createMutationRecord(6, ["packages/core/src/index.ts"], "EDIT"),
  ];

  const staleTest = findReusableEvidence(
    evidenceLedger,
    "pnpm --filter @autoeq-workbench/core test",
    6,
    mutations
  );
  assert.equal(staleTest.reusable, false);
  assert.equal(staleTest.fresh, false);
});

test("v3: SHELL_OVERUSE diagnostic distinguishes shell inspection from legitimate execution", () => {
  // Scenario 1: 8 shell search/read calls, 1 native read call -> SHELL_OVERUSE diagnostic
  const mix1 = {
    native_read_calls: 1,
    native_search_calls: 0,
    native_find_calls: 0,
    native_edit_calls: 0,
    shell_calls: 8,
    shell_read_calls: 4,
    shell_search_calls: 3,
    shell_discovery_calls: 1,
    shell_validation_calls: 0,
    shell_test_calls: 0,
    shell_build_calls: 0,
    avoidable_shell_calls: 8,
  };
  const overuse1 = detectShellOveruse(mix1);
  assert.equal(overuse1.overuseDetected, true);
  assert(overuse1.reason.includes("SHELL_OVERUSE"));

  // Scenario 2: 5 run_command calls, all test/build/benchmark -> NO SHELL_OVERUSE
  const mix2 = {
    native_read_calls: 2,
    native_search_calls: 2,
    native_find_calls: 1,
    native_edit_calls: 1,
    shell_calls: 5,
    shell_read_calls: 0,
    shell_search_calls: 0,
    shell_discovery_calls: 0,
    shell_validation_calls: 2,
    shell_test_calls: 2,
    shell_build_calls: 1,
    avoidable_shell_calls: 0,
  };
  const overuse2 = detectShellOveruse(mix2);
  assert.equal(overuse2.overuseDetected, false);
  assert.equal(overuse2.reason, null);
});

test("v4: calculateViewTargetWindow implements Search-to-Window targeted bounds", () => {
  // Line 100 with default before 35, after 45 -> [65, 145], 81 lines
  const w1 = calculateViewTargetWindow(100);
  assert.equal(w1.StartLine, 65);
  assert.equal(w1.EndLine, 145);
  assert.equal(w1.lineCount, 81);

  // Line 10 clamped to start 1
  const w2 = calculateViewTargetWindow(10);
  assert.equal(w2.StartLine, 1);
  assert.equal(w2.EndLine, 55);

  // Clamped by totalLines
  const w3 = calculateViewTargetWindow(95, { before: 10, after: 20, totalLines: 100 });
  assert.equal(w3.StartLine, 85);
  assert.equal(w3.EndLine, 100);
  assert.equal(w3.lineCount, 16);
});

test("v4: validateWorkerPacket enforces size bounds and raw code dump checks", () => {
  // Clean, concise packet
  const validPacket = `STATUS: IMPLEMENTATION_COMPLETE
FILES CHANGED: packages/core/src/dsp.ts
WHAT CHANGED: corrected biquad coefficient damping formula
TESTS: 12 passed / 0 failed
ACCEPTANCE EVIDENCE: pnpm --filter @autoeq-workbench/core test passed (exitCode 0)
SCOPE STATUS: COMPLIANT
BLOCKERS: none`;
  const res1 = validateWorkerPacket(validPacket);
  assert.equal(res1.valid, true);
  assert.equal(res1.exceedsLimits, false);

  // Exceeds character limit
  const hugePacket = "x".repeat(WORKER_PACKET_LIMITS.MAX_CHARS + 50);
  const res2 = validateWorkerPacket(hugePacket);
  assert.equal(res2.valid, false);
  assert.equal(res2.exceedsLimits, true);
  assert(res2.violations.some((v) => v.includes("WORKER_PACKET_EXCEEDS_MAX_CHARS")));

  // Code dump antipattern
  const codeDumpPacket = "```typescript\n" + "const foo = 1;\n".repeat(250) + "```";
  const res3 = validateWorkerPacket(codeDumpPacket);
  assert.equal(res3.valid, false);
  assert(res3.violations.some((v) => v.includes("WORKER_PACKET_RAW_CODE_DUMP")));
});

test("v4: classifyShellMutation identifies mutating shell commands and scope", () => {
  // Redirection
  const m1 = classifyShellMutation("echo 'export default {}' > packages/core/src/config.ts");
  assert.equal(m1.isMutation, true);
  assert.equal(m1.scope, "@autoeq-workbench/core");
  assert.equal(m1.unknownScope, false);

  // Ambiguous sed -i
  const m2 = classifyShellMutation("sed -i 's/foo/bar/g' somefile.txt");
  assert.equal(m2.isMutation, true);
  assert.equal(m2.unknownScope, true);

  // Codegen script
  const m3 = classifyShellMutation("pnpm run generate");
  assert.equal(m3.isMutation, true);
  assert.equal(m3.unknownScope, true);

  // Read-only / inspection command
  const m4 = classifyShellMutation("pnpm --filter @autoeq-workbench/core test");
  assert.equal(m4.isMutation, false);
});

test("v4: unknown-scope shell mutation invalidates code evidence conservatively", () => {
  const ev = {
    type: "TEST_RUN",
    scope: "@autoeq-workbench/core",
    command: "pnpm --filter @autoeq-workbench/core test",
    exitCode: 0,
    mutationSeq: 5,
  };

  // Unknown scope mutation at seq 6
  const mutations = [
    {
      mutationSeq: 6,
      paths: [],
      type: "SHELL_MUTATION",
      scope: "GLOBAL",
      unknownScope: true,
      command: "pnpm run generate",
    },
  ];

  const freshness = checkEvidenceFreshness(ev, 6, mutations);
  assert.equal(freshness.fresh, false);
  assert.equal(freshness.staleReason, "UNKNOWN_SCOPE_MUTATION_INVALIDATION");
});

test("v4: trackGitInspection tracks inspections and flags redundant calls", () => {
  const state = {
    toolMix: createInitialToolMix(),
    mutationSeq: 3,
  };

  // First git diff
  const t1 = trackGitInspection(state, "git diff");
  assert.equal(t1.isGitInspection, true);
  assert.equal(t1.isRedundant, false);
  assert.equal(state.toolMix.git_inspection_calls, 1);
  assert.equal(state.toolMix.redundant_git_inspections, 0);

  // Second git diff with NO mutation (mutationSeq still 3)
  const t2 = trackGitInspection(state, "git diff");
  assert.equal(t2.isGitInspection, true);
  assert.equal(t2.isRedundant, true);
  assert.equal(state.toolMix.git_inspection_calls, 2);
  assert.equal(state.toolMix.redundant_git_inspections, 1);

  // Mutation occurs
  state.mutationSeq = 4;

  // Third git diff after mutation
  const t3 = trackGitInspection(state, "git diff");
  assert.equal(t3.isGitInspection, true);
  assert.equal(t3.isRedundant, false);
  assert.equal(state.toolMix.git_inspection_calls, 3);
  assert.equal(state.toolMix.redundant_git_inspections, 1);
});

test("v4: advisory lifecycle advances pending -> delivered -> consumed without reinjection", () => {
  const state = { toolMix: createInitialToolMix() };

  createAdvisory(state, { id: "adv-1", message: "Targeted window advice" });
  assert.equal(state.advisories.length, 1);
  assert.equal(state.advisories[0].status, "PENDING");
  assert.equal(state.toolMix.advisories_created, 1);

  // Deliver pending
  const delivered = deliverPendingAdvisories(state);
  assert.equal(delivered.length, 1);
  assert.equal(state.advisories[0].status, "DELIVERED");
  assert.equal(state.toolMix.advisories_delivered, 1);

  // Deliver again when none are pending returns empty array
  const deliveredAgain = deliverPendingAdvisories(state);
  assert.equal(deliveredAgain.length, 0);

  // Consume delivered
  const consumedCount = consumeDeliveredAdvisories(state);
  assert.equal(consumedCount, 1);
  assert.equal(state.advisories.length, 0);
  assert.equal(state.toolMix.advisories_consumed, 1);
});

test("v4: planVerificationBatch skips steps with fresh evidence and plans missing/stale steps", () => {
  const state = {
    evidenceLedger: [
      {
        id: "ev-types",
        type: "TYPECHECK",
        scope: "@autoeq-workbench/core",
        command: "pnpm --filter @autoeq-workbench/core run typecheck",
        exitCode: 0,
        mutationSeq: 10,
      },
    ],
    mutationSeq: 10,
    mutations: [],
  };

  const requested = [
    {
      id: "types",
      command: "pnpm --filter @autoeq-workbench/core run typecheck",
      scope: "@autoeq-workbench/core",
    },
    {
      id: "tests",
      command: "pnpm --filter @autoeq-workbench/core test",
      scope: "@autoeq-workbench/core",
      dependsOn: "types",
    },
  ];

  const plan = planVerificationBatch(state, requested);
  assert.equal(plan.reusedCount, 1);
  assert.equal(plan.skippedSteps[0].id, "types");
  assert.equal(plan.skippedSteps[0].skipReason, "FRESH_EVIDENCE_REUSE");

  assert.equal(plan.plannedSteps.length, 1);
  assert.equal(plan.plannedSteps[0].id, "tests");
});

test("v5: classifyDirectActionIntent classifies routine operational requests", () => {
  assert.deepEqual(classifyDirectActionIntent("commita"), { isDirectAction: true, type: "GIT_COMMIT", reason: "explicit_git_commit" });
  assert.deepEqual(classifyDirectActionIntent("pusha"), { isDirectAction: true, type: "GIT_PUSH", reason: "explicit_git_push" });
  assert.deepEqual(classifyDirectActionIntent("commita e pusha"), { isDirectAction: true, type: "GIT_COMMIT_PUSH", reason: "explicit_commit_push" });
  assert.deepEqual(classifyDirectActionIntent("commit and push"), { isDirectAction: true, type: "GIT_COMMIT_PUSH", reason: "explicit_commit_push" });
  assert.deepEqual(classifyDirectActionIntent("mostra o git status"), { isDirectAction: true, type: "GIT_STATUS", reason: "explicit_git_status" });
  assert.deepEqual(classifyDirectActionIntent("mostra o diff"), { isDirectAction: true, type: "GIT_DIFF", reason: "explicit_git_diff" });
  assert.deepEqual(classifyDirectActionIntent("roda o typecheck"), { isDirectAction: true, type: "RUN_TYPECHECK", reason: "explicit_typecheck" });
  assert.deepEqual(classifyDirectActionIntent("roda os testes"), { isDirectAction: true, type: "RUN_TEST", reason: "explicit_test" });
  assert.deepEqual(classifyDirectActionIntent("roda o build"), { isDirectAction: true, type: "RUN_BUILD", reason: "explicit_build" });
  assert.deepEqual(classifyDirectActionIntent("executa esse script"), { isDirectAction: true, type: "RUN_PROJECT_SCRIPT", reason: "explicit_project_script" });
});

test("v5: classifyDirectActionIntent rejects compound intents requiring technical work", () => {
  const c1 = classifyDirectActionIntent("corrija os erros e depois commita");
  assert.equal(c1.isDirectAction, false);
  assert.equal(c1.reason, "compound_intent_requires_technical_work");

  const c2 = classifyDirectActionIntent("corrija o bug e commita");
  assert.equal(c2.isDirectAction, false);
  assert.equal(c2.reason, "compound_intent_requires_technical_work");

  const c3 = classifyDirectActionIntent("analise se está tudo certo e se estiver commita");
  assert.equal(c3.isDirectAction, false);
  assert.equal(c3.reason, "compound_intent_requires_technical_work");

  const c4 = classifyDirectActionIntent("implemente o filtro e pusha");
  assert.equal(c4.isDirectAction, false);
  assert.equal(c4.reason, "compound_intent_requires_technical_work");
});

test("v5: decideRoute routes DIRECT_ACTION to Orchestrator without subagents", () => {
  const res1 = decideRoute({ taskAction: "DIRECT_ACTION", directActionType: "GIT_COMMIT_PUSH" });
  assert.equal(res1.kind, "direct_action");
  assert.equal(res1.action, "DIRECT_ACTION");
  assert.equal(res1.directActionType, "GIT_COMMIT_PUSH");
  assert.equal(res1.model, GEMINI_MODELS.ORCHESTRATOR);
  assert.equal(res1.subagentsAllowed, false);
  assert.equal(res1.executor, "flash-orchestrator");

  // Also resolves from intent string directly
  const res2 = decideRoute({ prompt: "commita e pusha" });
  assert.equal(res2.kind, "direct_action");
  assert.equal(res2.action, "DIRECT_ACTION");
  assert.equal(res2.directActionType, "GIT_COMMIT_PUSH");
  assert.equal(res2.subagentsAllowed, false);
});

test("v5: state machine validates DIRECT_ACTION transitions and fails closed", () => {
  assert.equal(validateStateTransition("INTAKE", "DIRECT_ACTION").valid, true);
  assert.equal(validateStateTransition("CLASSIFIED", "DIRECT_ACTION").valid, true);
  assert.equal(validateStateTransition("DIRECT_ACTION", "EXECUTING").valid, true);
  assert.equal(validateStateTransition("DIRECT_ACTION", "DONE").valid, true);
  assert.equal(validateStateTransition("DIRECT_ACTION", "BLOCKED").valid, true);
  assert.equal(validateStateTransition("EXECUTING", "DONE", { taskAction: "DIRECT_ACTION" }).valid, true);
  assert.equal(validateStateTransition("EXECUTING", "DONE").valid, false);

  // Prohibited transitions
  assert.equal(validateStateTransition("DIRECT_ACTION", "PLANNED").valid, false);
  assert.equal(validateStateTransition("DIRECT_ACTION", "ACCEPTANCE").valid, false);
});

test("v5: GIT_EFFECT_TAXONOMY accurately classifies git commands and effects", () => {
  assert.equal(classifyGitEffect("git status").effect, GIT_EFFECT_TAXONOMY.GIT_READONLY);
  assert.equal(classifyGitEffect("git diff --stat").effect, GIT_EFFECT_TAXONOMY.GIT_READONLY);
  assert.equal(classifyGitEffect("git branch --show-current").effect, GIT_EFFECT_TAXONOMY.GIT_READONLY);

  assert.equal(classifyGitEffect("git add packages/core/src/index.ts").effect, GIT_EFFECT_TAXONOMY.GIT_INDEX_ONLY);
  assert.equal(classifyGitEffect("git restore --staged packages/core/src/index.ts").effect, GIT_EFFECT_TAXONOMY.GIT_INDEX_ONLY);

  assert.equal(classifyGitEffect("git commit -m 'feat: test'").effect, GIT_EFFECT_TAXONOMY.GIT_METADATA_ONLY);
  assert.equal(classifyGitEffect("git push origin main").effect, GIT_EFFECT_TAXONOMY.GIT_REMOTE_ONLY);

  assert.equal(classifyGitEffect("git checkout packages/core/src/dsp.ts").effect, GIT_EFFECT_TAXONOMY.GIT_WORKTREE_MUTATING);
  assert.equal(classifyGitEffect("git restore packages/core/src/dsp.ts").effect, GIT_EFFECT_TAXONOMY.GIT_WORKTREE_MUTATING);
  assert.equal(classifyGitEffect("git reset --hard").effect, GIT_EFFECT_TAXONOMY.GIT_WORKTREE_MUTATING);
  assert.equal(classifyGitEffect("git pull").effect, GIT_EFFECT_TAXONOMY.GIT_WORKTREE_MUTATING);

  // git-operation runner
  assert.equal(classifyGitEffect("node .agents/hooks/git-operation.mjs --action commit_push").effect, GIT_EFFECT_TAXONOMY.GIT_METADATA_ONLY);
});

test("v5: classifyShellMutation preserves mutationSeq for read, index, metadata, and remote git actions", () => {
  assert.equal(classifyShellMutation("git status").isMutation, false);
  assert.equal(classifyShellMutation("git add packages/core/src/index.ts").isMutation, false);
  assert.equal(classifyShellMutation("git commit -m 'feat: test'").isMutation, false);
  assert.equal(classifyShellMutation("git push origin main").isMutation, false);
  assert.equal(classifyShellMutation("node .agents/hooks/git-operation.mjs --action commit_push").isMutation, false);

  // Worktree mutating checkout DOES mutate and identifies scope
  const mutating = classifyShellMutation("git checkout packages/core/src/dsp.ts");
  assert.equal(mutating.isMutation, true);
  assert.equal(mutating.scope, "@autoeq-workbench/core");
  assert.equal(mutating.gitEffect, "GIT_WORKTREE_MUTATING");
});

test("v5: classifyExecutionEvidence classifies git commands as GIT_OPERATION", () => {
  const evCommit = classifyExecutionEvidence("git commit -m 'chore: test'", 0, "");
  assert.equal(evCommit.type, "GIT_OPERATION");
  assert.equal(evCommit.passed, 1);

  const evRunner = classifyExecutionEvidence("node .agents/hooks/git-operation.mjs --action commit_push", 0, "GIT_OPERATION_SUCCESS");
  assert.equal(evRunner.type, "GIT_OPERATION");
  assert.notEqual(evRunner.type, "TEST_RUN");
  assert.notEqual(evRunner.type, "TYPECHECK");
});

test("v5: tool mix telemetry tracks direct action metrics and diagnostics", () => {
  const state = {
    toolMix: {
      ...createInitialToolMix(),
      direct_actions: 2,
      direct_action_tool_calls: 3,
      direct_action_model_turns: 2,
      git_commit_push_count: 1,
      git_commit_push_tool_calls: 1,
      direct_action_blocked: 0,
      direct_action_side_quests_prevented: 1,
    }
  };

  const metrics = calculateToolMixMetrics(state.toolMix, 1);
  assert.equal(metrics.avg_tool_calls_per_direct_action, 1.5);
  assert.equal(metrics.commit_push_avg_tool_calls, 1.0);
  assert.equal(metrics.direct_action_side_quest_rate, 0.5);

  // Detect overhead
  assert.equal(detectDirectActionOverhead({ direct_action_tool_calls: 2 }).overheadDetected, false);
  const overhead = detectDirectActionOverhead({ direct_action_tool_calls: 5 });
  assert.equal(overhead.overheadDetected, true);
  assert(overhead.reason.includes("DIRECT_ACTION_OVERHEAD"));

  // Detect overthinking
  assert.equal(detectDirectActionOverthinking({ direct_action_model_turns: 1 }).overthinkingDetected, false);
  const overthink = detectDirectActionOverthinking({ direct_action_model_turns: 4 });
  assert.equal(overthink.overthinkingDetected, true);
  assert(overthink.reason.includes("DIRECT_ACTION_OVERTHINKING"));
});

test("dream routing parity matrix: preserves 100% routing parity across comprehensive fixture suite", () => {
  const fixtures = [
    // 1. Simple
    {
      name: "simple-implementation",
      facts: { taskAction: "IMPLEMENT", implementationComplexity: "simple" },
      expectedKind: "worker",
      expectedModel: GEMINI_MODELS.WORKER_LOW,
      expectedDreamDecision: { decisionType: "WORKER_TIER", chosenAction: "FLASH_LOW" },
      expectedLegalActions: ["FLASH_LOW", "FLASH_MEDIUM"],
    },
    // 2. Docs
    {
      name: "docs-implementation",
      facts: { taskAction: "IMPLEMENT", taskDomain: "DOCS" },
      expectedKind: "worker",
      expectedModel: GEMINI_MODELS.WORKER_LOW,
      expectedDreamDecision: { decisionType: "WORKER_TIER", chosenAction: "FLASH_LOW" },
      expectedLegalActions: ["FLASH_LOW", "FLASH_MEDIUM"],
    },
    // 3. Mechanical
    {
      name: "mechanical-fix",
      facts: { taskAction: "MECHANICAL_FIX" },
      expectedKind: "worker",
      expectedModel: GEMINI_MODELS.WORKER_LOW,
      expectedDreamDecision: { decisionType: "WORKER_TIER", chosenAction: "FLASH_LOW" },
      expectedLegalActions: ["FLASH_LOW", "FLASH_MEDIUM"],
    },
    // 4. Normal
    {
      name: "normal-implementation",
      facts: { taskAction: "IMPLEMENT", implementationComplexity: "normal" },
      expectedKind: "worker",
      expectedModel: GEMINI_MODELS.WORKER_MEDIUM,
      expectedDreamDecision: { decisionType: "WORKER_TIER", chosenAction: "FLASH_MEDIUM" },
      expectedLegalActions: ["FLASH_MEDIUM", "FLASH_HIGH"],
    },
    // 5. Difficult
    {
      name: "difficult-implementation",
      facts: { taskAction: "IMPLEMENT", implementationComplexity: "difficult" },
      expectedKind: "worker",
      expectedModel: GEMINI_MODELS.WORKER_HIGH,
      expectedDreamDecision: { decisionType: "WORKER_TIER", chosenAction: "FLASH_HIGH" },
      expectedLegalActions: ["FLASH_HIGH"],
    },
    // 6. Experimental
    {
      name: "experimental-implementation",
      facts: { taskAction: "IMPLEMENT", complexity: "experimental", experimental: true },
      expectedKind: "worker",
      expectedModel: GEMINI_MODELS.WORKER_HIGH,
      expectedDreamDecision: { decisionType: "WORKER_TIER", chosenAction: "FLASH_HIGH" },
      expectedLegalActions: ["FLASH_HIGH"],
    },
    // 7. Post-investigation
    {
      name: "post-investigation-implementation",
      facts: { taskAction: "IMPLEMENT", postInvestigation: true },
      expectedKind: "worker",
      expectedModel: GEMINI_MODELS.WORKER_HIGH,
      expectedDreamDecision: { decisionType: "WORKER_TIER", chosenAction: "FLASH_HIGH" },
      expectedLegalActions: ["FLASH_HIGH"],
    },
    // 8. Testing
    {
      name: "test-execution",
      facts: { taskAction: "TEST", implementationComplexity: "normal" },
      expectedKind: "worker",
      expectedModel: GEMINI_MODELS.WORKER_MEDIUM,
      expectedDreamDecision: { decisionType: "WORKER_TIER", chosenAction: "FLASH_MEDIUM" },
      expectedLegalActions: ["FLASH_LOW", "FLASH_MEDIUM"],
    },
    {
      name: "test-difficult-parity",
      facts: { taskAction: "TEST", implementationComplexity: "difficult" },
      expectedKind: "worker",
      expectedModel: GEMINI_MODELS.WORKER_MEDIUM,
      expectedDreamDecision: { decisionType: "WORKER_TIER", chosenAction: "FLASH_MEDIUM" },
      expectedLegalActions: ["FLASH_LOW", "FLASH_MEDIUM"],
    },
    // 9. Integration
    {
      name: "integration-implementation",
      facts: { taskAction: "IMPLEMENT", integration: true },
      expectedKind: "worker",
      expectedModel: GEMINI_MODELS.WORKER_HIGH,
      expectedDreamDecision: { decisionType: "WORKER_TIER", chosenAction: "FLASH_HIGH" },
      expectedLegalActions: ["FLASH_HIGH"],
    },
    // 10. Investigation
    {
      name: "investigation-action",
      facts: { taskAction: "INVESTIGATE" },
      expectedKind: "orchestration",
      expectedModel: GEMINI_MODELS.INVESTIGATOR,
      expectedDreamDecision: null,
    },
    // 11. Retry: FAILED_TEST
    {
      name: "retry-failed-test",
      facts: { taskAction: "IMPLEMENT", retry: true, retry_reason: "FAILED_TEST" },
      expectedKind: "worker",
      expectedDreamDecision: { decisionType: "RETRY_ACTION", chosenAction: "RETRY_SAME" },
      expectedLegalActions: ["RETRY_SAME", "ESCALATE_WORKER", "INVESTIGATE_FIRST"],
    },
    // 12. Retry: INCOMPLETE_IMPLEMENTATION
    {
      name: "retry-incomplete-implementation",
      facts: { taskAction: "IMPLEMENT", retry: true, retry_reason: "INCOMPLETE_IMPLEMENTATION" },
      expectedKind: "worker",
      expectedDreamDecision: { decisionType: "RETRY_ACTION", chosenAction: "RETRY_SAME" },
      expectedLegalActions: ["RETRY_SAME", "ESCALATE_WORKER"],
    },
    // 13. Retry: MISSING_CONTEXT with INVESTIGATE_FIRST
    {
      name: "retry-missing-context",
      facts: { retry: true, retry_reason: "MISSING_CONTEXT", retryAction: "INVESTIGATE_FIRST" },
      expectedDreamDecision: { decisionType: "RETRY_ACTION", chosenAction: "INVESTIGATE_FIRST" },
      expectedLegalActions: ["INVESTIGATE_FIRST", "REPLAN"],
    },
    // 14. Retry: MISINTERPRETED_REQUIREMENT with REPLAN
    {
      name: "retry-misinterpreted-requirement",
      facts: { retry: true, retry_reason: "MISINTERPRETED_REQUIREMENT", retryAction: "REPLAN" },
      expectedDreamDecision: { decisionType: "RETRY_ACTION", chosenAction: "REPLAN" },
      expectedLegalActions: ["REPLAN"],
    },
    // 15. Retry: SCOPE_GAP with REPLAN
    {
      name: "retry-scope-gap",
      facts: { retry: true, retry_reason: "SCOPE_GAP", retryAction: "REPLAN" },
      expectedDreamDecision: { decisionType: "RETRY_ACTION", chosenAction: "REPLAN" },
      expectedLegalActions: ["REPLAN"],
    },
    // 16. Retry: INTEGRATION_FAILURE with ESCALATE_WORKER
    {
      name: "retry-integration-failure",
      facts: { retry: true, retry_reason: "INTEGRATION_FAILURE", retryAction: "ESCALATE_WORKER" },
      expectedDreamDecision: { decisionType: "RETRY_ACTION", chosenAction: "ESCALATE_WORKER" },
      expectedLegalActions: ["ESCALATE_WORKER", "REPLAN"],
    },
    // 17. Direct Action: explicit taskAction
    {
      name: "direct-action-explicit",
      facts: { taskAction: "DIRECT_ACTION", directActionType: "GIT_STATUS" },
      expectedKind: "direct_action",
      expectedDreamDecision: null,
    },
    // 18. Direct Action: natural language intent
    {
      name: "direct-action-prompt-intent",
      facts: { intent: "git status" },
      expectedKind: "direct_action",
      expectedDreamDecision: null,
    },
    // 19. CRITICAL review (decideRoute control plane)
    {
      name: "critical-review-control-plane",
      facts: { taskAction: "REVIEW", criticality: "CRITICAL" },
      expectedKind: "orchestration",
      expectedDreamDecision: null,
    },
    // 20. Two-Key Review (reviewRoute)
    {
      name: "two-key-review",
      useReviewRoute: true,
      facts: { criticality: "CRITICAL", acceptanceCriteriaStatus: "passed" },
      expectedKind: "two-key-review",
      expectedDreamDecision: null,
    },
    // 21. Unknown / default orchestration
    {
      name: "default-orchestration",
      facts: {},
      expectedKind: "orchestration",
      expectedDreamDecision: null,
    },
  ];

  for (const fixture of fixtures) {
    const route = fixture.useReviewRoute ? reviewRoute(fixture.facts) : decideRoute(fixture.facts);
    if (fixture.expectedKind) {
      assert.equal(
        route.kind,
        fixture.expectedKind,
        `[${fixture.name}] Expected route kind ${fixture.expectedKind}, got ${route.kind}`,
      );
    }
    if (fixture.expectedModel) {
      assert.equal(
        route.model,
        fixture.expectedModel,
        `[${fixture.name}] Expected route model ${fixture.expectedModel}, got ${route.model}`,
      );
    }

    const decisionState = deriveDecisionState(fixture.facts);
    const dreamDecision = classifyBaselineDecision(fixture.facts, route);

    assert.deepEqual(
      dreamDecision,
      fixture.expectedDreamDecision,
      `[${fixture.name}] Mismatched baseline classification: ${JSON.stringify(dreamDecision)} vs ${JSON.stringify(fixture.expectedDreamDecision)}`,
    );

    if (dreamDecision !== null) {
      const availableActions = deriveAvailableActions(dreamDecision.decisionType, decisionState);
      assert.ok(
        availableActions.includes(dreamDecision.chosenAction),
        `[${fixture.name}] Chosen action "${dreamDecision.chosenAction}" must be in available actions [${availableActions.join(", ")}]`,
      );
      if (fixture.expectedLegalActions) {
        assert.deepEqual(
          availableActions,
          fixture.expectedLegalActions,
          `[${fixture.name}] Mismatched available actions: [${availableActions.join(", ")}] vs [${fixture.expectedLegalActions.join(", ")}]`,
        );
      }

      // Milestone D: declarative static-policy-v1 parity assertion
      const policyRes = evaluatePolicy({
        policy: staticPolicy,
        decisionType: dreamDecision.decisionType,
        state: decisionState,
        availableActions,
        baselineAction: dreamDecision.chosenAction,
      });
      assert.equal(
        policyRes.ok,
        true,
        `[${fixture.name}] static-policy-v1 must match state: ${policyRes.diagnostic}`,
      );
      assert.equal(
        policyRes.action,
        dreamDecision.chosenAction,
        `[${fixture.name}] static-policy-v1 must match baseline chosen action: got ${policyRes.action}, expected ${dreamDecision.chosenAction}`,
      );
    }
  }
});


test("scope validator canonicalizes dot-dot traversal before authorization", () => {
  const contract = {
    allowedPaths: ["src/**"],
    forbiddenPaths: [".agents/**"],
  };

  const intoControlPlane = validateScopeContract(contract, ["src/../.agents/state/pwn.json"]);
  assert.equal(intoControlPlane.valid, false);
  assert.ok(intoControlPlane.violations.some((v) =>
    v.path === ".agents/state/pwn.json" && v.reason === "forbidden-path"
  ));

  const outsideWorkspace = validateScopeContract(contract, ["src/../../outside.js"]);
  assert.equal(outsideWorkspace.valid, false);
  assert.ok(outsideWorkspace.violations.some((v) => v.reason === "workspace-escape"));
});


test("validation authority: MEDIUM or missing worker identity confidence cannot satisfy acceptance", () => {
  const base = {
    mutationSeq: 0,
    scopeContract: { testsRequired: ["npm test"] },
  };

  const medium = verifyWorkerValidation({
    ...base,
    evidenceLedger: [{
      executionId: "medium-ev",
      type: "TEST_RUN",
      command: "npm test",
      exitCode: 0,
      mutationSeq: 0,
      actorRole: "WORKER",
      confidence: "MEDIUM",
    }],
  });
  assert.equal(medium.verified, false);
  assert.match(medium.reason, /IDENTITY_NOT_FACTUAL/);

  const missing = verifyWorkerValidation({
    ...base,
    evidenceLedger: [{
      executionId: "missing-confidence-ev",
      type: "TEST_RUN",
      command: "npm test",
      exitCode: 0,
      mutationSeq: 0,
      actorRole: "WORKER",
    }],
  });
  assert.equal(missing.verified, false);
  assert.match(missing.reason, /IDENTITY_NOT_FACTUAL/);

  const investigator = verifyWorkerValidation({
    ...base,
    evidenceLedger: [{
      executionId: "investigator-ev",
      type: "TEST_RUN",
      command: "npm test",
      exitCode: 0,
      mutationSeq: 0,
      actorRole: "WORKER",
      confidence: "HIGH",
      delegationKind: "INVESTIGATION",
    }],
  });
  assert.equal(investigator.verified, false);
  assert.match(investigator.reason, /INVALID_DELEGATION/);

  const factual = verifyWorkerValidation({
    ...base,
    evidenceLedger: [{
      executionId: "high-ev",
      type: "TEST_RUN",
      command: "npm test",
      exitCode: 0,
      mutationSeq: 0,
      actorRole: "WORKER",
      confidence: "HIGH",
      delegationKind: "WORK",
    }],
  });
  assert.equal(factual.verified, true);
});


test("validation authority: retry attempts cannot reuse prior-attempt evidence", () => {
  const previousAttemptEvidence = {
    executionId: "attempt-0-test",
    type: "TEST_RUN",
    command: "npm test",
    exitCode: 0,
    mutationSeq: 0,
    actorRole: "WORKER",
    confidence: "HIGH",
    delegationKind: "WORK",
    attempt: 0,
  };

  const retryWithoutNewEvidence = verifyWorkerValidation({
    attempt: 1,
    mutationSeq: 0,
    scopeContract: { testsRequired: ["npm test"] },
    evidenceLedger: [previousAttemptEvidence],
  });
  assert.equal(retryWithoutNewEvidence.verified, false);
  assert.match(retryWithoutNewEvidence.reason, /ATTEMPT_MISMATCH/);

  const retryWithCurrentEvidence = verifyWorkerValidation({
    attempt: 1,
    mutationSeq: 0,
    scopeContract: { testsRequired: ["npm test"] },
    evidenceLedger: [
      previousAttemptEvidence,
      {
        ...previousAttemptEvidence,
        executionId: "attempt-1-test",
        attempt: 1,
      },
    ],
  });
  assert.equal(retryWithCurrentEvidence.verified, true);
  assert.equal(retryWithCurrentEvidence.evidence.attempt, 1);

  const initialLegacyEvidence = verifyWorkerValidation({
    attempt: 0,
    mutationSeq: 0,
    scopeContract: { testsRequired: ["npm test"] },
    evidenceLedger: [{
      ...previousAttemptEvidence,
      executionId: "legacy-attempt-zero",
      attempt: undefined,
    }],
  });
  assert.equal(initialLegacyEvidence.verified, true, "Legacy missing attempt is compatible only with initial attempt 0");
});
