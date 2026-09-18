import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ACTIONS,
  DIRECT_ACTIONS,
  COMMAND_SEMANTICS,
  CODEX_MODELS,
  CROSS_DOMAIN_REQUEST,
  STATE_NAMES,
  TASK_DOMAINS,
  CORE_TASK_DOMAINS,
  registerCustomDomains,
  canWorkerAccept,
  canWorkerSpawn,
  canonicalTaskDomain,
  consumeRetryBudget,
  createAcceptanceGate,
  createAstraEscalationPacket,
  createCrossDomainRequest,
  createImplementationHandoff,
  createIntegrationContract,
  createRetryBudget,
  createScopeContract,
  decideRoute,
  directWriteDecision,
  evaluateAcceptance,
  evaluateCriticalReview,
  evaluateDirectAction,
  createCommandResult,
  evaluateCommandResult,
  evaluateCodexExecEvents,
  requiresIntegration,
  reviewRoute,
  scanCodexSkillIsolation,
  scanCodexOperationalFiles,
  validateCodexRoute,
  validateAstraEscalationPacket,
  validateScopeContract,
  validateStateTransition,
  isDirectAction,
  validateWorkerCompletion,
} from "./routing-policy.mjs";

const assertCodexRoute = (route) => {
  assert.equal(route.model.startsWith("gpt-"), true);
  assert.equal(validateCodexRoute(route).valid, true);
  assert.equal(route.model.includes("gemini"), false);
  assert.equal(route.executor.includes("flash"), false);
};

test("Terra Medium is the default control plane", () => {
  const route = decideRoute({ taskAction: "ORCHESTRATE" });
  assert.equal(route.profile, "terra-medium");
  assert.equal(route.model, CODEX_MODELS.TERRA_MEDIUM.model);
  assert.equal(route.reasoningEffort, "medium");
  assert.equal(route.owner, "terra");
  assertCodexRoute(route);
});

test("simple implementation routes to Luna High", () => {
  const route = decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "simple" });
  assert.equal(route.profile, "luna-high");
  assert.equal(route.reasoningEffort, "high");
  assert.equal(route.owner, "luna");
  assertCodexRoute(route);
});

test("normal implementation routes to Luna Max", () => {
  const route = decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "normal" });
  assert.equal(route.profile, "luna-max");
  assert.equal(route.reasoningEffort, "max");
  assert.equal(route.owner, "luna");
  assertCodexRoute(route);
});

test("deep investigation routes to Terra High", () => {
  const route = decideRoute({ taskAction: "INVESTIGATE", investigationEffort: "high" });
  assert.equal(route.profile, "terra-high");
  assert.equal(route.owner, "terra");
  assertCodexRoute(route);
});

test("justified deeper investigation routes to Terra XHigh", () => {
  const route = decideRoute({
    taskAction: "INVESTIGATE",
    investigationEffort: "xhigh",
    justification: "High left two conflicting hypotheses",
    evidence: ["reproduction remains nondeterministic"],
  });
  assert.equal(route.profile, "terra-xhigh");
  assert.equal(route.escalationJustified, true);
  assertCodexRoute(route);
});

test("exceptional investigation routes to Terra Max only with evidence", () => {
  const route = decideRoute({
    taskAction: "INVESTIGATE",
    investigationEffort: "max",
    justification: "XHigh was insufficient",
    evidence: ["three focused experiments inconclusive"],
    priorAttempts: 2,
  });
  assert.equal(route.profile, "terra-max");
  assert.equal(route.escalationJustified, true);
  assertCodexRoute(route);
});

test("CRITICAL review routes to rare Sol Low independent review", () => {
  const route = decideRoute({ taskAction: "REVIEW", criticality: "CRITICAL" });
  assert.equal(route.profile, "sol-low");
  assert.equal(route.owner, "sol");
  assert.equal(route.independent, true);
  assertCodexRoute(route);
});

test("justified specialist escalation routes to Sol Medium", () => {
  const route = decideRoute({
    taskAction: "ESCALATE",
    specialistLevel: "medium",
    escalationJustified: true,
    evidence: ["Sol Low could not resolve a specific uncertainty"],
  });
  assert.equal(route.profile, "sol-medium");
  assert.equal(route.owner, "sol");
  assertCodexRoute(route);
});

test("Astra is manual-only after an explicit approved packet", () => {
  const packet = createAstraEscalationPacket({
    problem: "Specific unresolved question",
    evidence: ["measured result"],
    question: "What should be tested next?",
    successCriterion: "A falsifiable decision",
  });
  assert.equal(validateAstraEscalationPacket(packet).valid, true);
  const route = decideRoute({
    taskAction: "ASTRA",
    astraApproved: true,
    astraEscalationPacket: packet,
  });
  assert.equal(route.profile, "astra-manual");
  assert.equal(route.manualOnly, true);
  assert.equal(route.automatic, false);
  assert.equal(route.model, "gpt-6-astra");
});

test("Astra cannot be an automatic fallback", () => {
  const route = decideRoute({ taskAction: "IMPLEMENT", fallback: true, fallbackTarget: "astra" });
  assert.notEqual(route.profile, "astra-manual");
  assert.equal(route.astraBlocked, true);
  assert.equal(route.profile, "terra-medium");
  assertCodexRoute(route);
});

test("workers cannot spawn or coordinate workers", () => {
  assert.equal(canWorkerSpawn("luna-max"), false);
  assert.equal(canWorkerSpawn("terra-high"), false);
  assert.equal(canWorkerSpawn("terra-medium"), false);
});

test("workers cannot self-accept", () => {
  assert.equal(canWorkerAccept("luna-max"), false);
  assert.equal(canWorkerAccept("luna-high"), false);
  assert.equal(canWorkerAccept("sol-low"), false);
});

test("CROSS_DOMAIN_REQUEST returns control to Terra", () => {
  const request = createCrossDomainRequest({
    currentDomain: "UI",
    requiredDomain: "DSP_CORE",
    reason: "UI needs a missing core capability",
    requestedCapability: "Expose response summary",
    evidence: ["No public API exists"],
  });
  assert.equal(request.type, CROSS_DOMAIN_REQUEST);
  assert.equal(request.blocking, true);
  const route = reviewRoute({ crossDomainRequest: request });
  assert.equal(route.profile, "terra-medium");
  assert.equal(route.controlReturned, true);
});

test("task domains normalize to the canonical vocabulary", () => {
  assert.equal(canonicalTaskDomain("code"), "CODE");
  assert.equal(canonicalTaskDomain("dsp"), "DSP_CORE");
  assert.equal(canonicalTaskDomain("auto_eq_algorithm"), "AUTOEQ_ALGORITHM");
  assert.equal(canonicalTaskDomain("documentation"), "DOCS");
  assert.equal(canonicalTaskDomain("unknown-domain"), "GENERAL");
  assert.deepEqual(CORE_TASK_DOMAINS, [
    "CODE", "UI", "DATA", "INFRA",
    "TESTING", "DOCS", "RESEARCH", "ORCHESTRA", "GENERAL",
  ]);
  registerCustomDomains(["CUSTOM_DOMAIN"]);
  assert.equal(canonicalTaskDomain("custom_domain"), "CUSTOM_DOMAIN");
});

test("scopeContract enforces allowed and forbidden paths", () => {
  const contract = createScopeContract({
    taskAction: "IMPLEMENT",
    taskDomain: "DSP_CORE",
    allowedPaths: ["packages/core/src/dsp/**"],
    forbiddenPaths: ["apps/**", "vendor/**"],
  });
  assert.equal(validateScopeContract(contract, ["packages/core/src/dsp/biquad.ts"]).valid, true);
  const violation = validateScopeContract(contract, ["apps/web/src/App.tsx", "vendor/squiglink/ref.js"]);
  assert.equal(violation.valid, false);
  assert.deepEqual(violation.violations.sort(), [
    "apps/web/src/App.tsx",
    "vendor/squiglink/ref.js",
  ]);
});

test("retry budgets are bounded and consume one attempt", () => {
  const normal = createRetryBudget({ implementationComplexity: "normal" });
  const experimental = createRetryBudget({ implementationComplexity: "experimental" });
  assert.equal(normal.maxAttempts, 2);
  assert.equal(experimental.maxAttempts, 3);
  const next = consumeRetryBudget(normal);
  assert.deepEqual(next, { maxAttempts: 2, attempt: 1, remainingAttempts: 1 });
  assert.deepEqual(consumeRetryBudget({ maxAttempts: 1, attempt: 1, remainingAttempts: 0 }), {
    maxAttempts: 1,
    attempt: 1,
    remainingAttempts: 0,
  });
});

test("partial worker result gets a bounded Luna retry, exhaustion returns Terra", () => {
  const retry = reviewRoute({
    taskAction: "IMPLEMENT",
    implementationComplexity: "normal",
    workerResult: { status: "IMPLEMENTATION_COMPLETE", complete: false },
    retryBudget: { maxAttempts: 2, attempt: 0, remainingAttempts: 2 },
    gap: "missing acceptance assertion",
  });
  assert.equal(retry.profile, "luna-max");
  assert.equal(retry.retry, true);
  assert.equal(retry.remainingAttempts, 1);

  const exhausted = reviewRoute({
    taskAction: "IMPLEMENT",
    workerResult: { status: "IMPLEMENTATION_COMPLETE", complete: false },
    retryBudget: { maxAttempts: 1, attempt: 1, remainingAttempts: 0 },
  });
  assert.equal(exhausted.profile, "terra-medium");
  assert.equal(exhausted.retryAllowed, false);
  assert.equal(exhausted.replanRequired, true);
});

test("IMPLEMENTATION_COMPLETE is evidence, not acceptance", () => {
  const result = evaluateAcceptance({
    workerResult: { status: "IMPLEMENTATION_COMPLETE", complete: true },
    requiredTests: ["unit"],
    evidence: [],
    changedPaths: ["packages/core/src/dsp/biquad.ts"],
    scopeContract: createScopeContract({ allowedPaths: ["packages/core/src/dsp/**"] }),
  });
  assert.equal(result.accepted, false);
  assert.equal(result.result, "EVIDENCE_INCOMPLETE");
  assert.equal(createAcceptanceGate({ workerResult: { status: "IMPLEMENTATION_COMPLETE" } }).owner, "terra");
});

test("acceptance requires objective evidence and a compliant scope", () => {
  const contract = createScopeContract({ allowedPaths: ["packages/core/src/dsp/**"] });
  const result = evaluateAcceptance({
    workerResult: { status: "IMPLEMENTATION_COMPLETE", complete: true },
    requiredTests: ["unit"],
    evidence: [{ command: "unit", exitCode: 0, failed: 0 }],
    changedPaths: ["packages/core/src/dsp/biquad.ts"],
    scopeContract: contract,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.result, "ACCEPTED");
});

test("integration gate is absent for one deliverable and required for many", () => {
  assert.equal(requiresIntegration({ deliverables: ["one"], taskDomains: ["DSP_CORE"] }), false);
  assert.equal(requiresIntegration({ deliverables: ["one", "two"] }), true);
  const contract = createIntegrationContract({ deliverables: ["one", "two"], taskDomains: ["DSP_CORE", "UI"] });
  assert.equal(contract.profile, "luna-max");
  assert.equal(contract.operation, "INTEGRATE");
  assert.equal(contract.owner, "luna");
});

test("Sol findings return to Terra instead of self-implementation", () => {
  const route = reviewRoute({
    criticality: "CRITICAL",
    reviewerVerdict: "CHANGES_REQUIRED",
    findings: ["edge case not covered"],
  });
  assert.equal(route.profile, "terra-medium");
  assert.equal(route.findingsReturned, true);
  assert.equal(route.implementationExecutor, "luna-max");
});

test("state transitions fail closed for unknown or prohibited transitions", () => {
  assert.equal(validateStateTransition("INTAKE", "CLASSIFIED").valid, true);
  assert.equal(validateStateTransition("DONE", "EXECUTING").valid, false);
  assert.equal(validateStateTransition("NO_SUCH_STATE", "DONE").error, "INVALID_TRANSITION");
  assert.equal(STATE_NAMES.includes("HUMAN_GATE"), true);
});

test("unknown actions fail closed without an active provider route", () => {
  const route = decideRoute({ taskAction: "NOT_A_REAL_ACTION" });
  assert.equal(route.valid, false);
  assert.equal(route.error, "INVALID_ROUTE");
  assert.equal(route.model, null);
});

test("direct writes are limited to explicit control-plane mechanics", () => {
  assert.deepEqual(directWriteDecision({ taskAction: "ORCHESTRATE", controlPlaneWork: true }), {
    allowed: true,
    reason: "control-plane",
  });
  assert.equal(directWriteDecision({ taskAction: "IMPLEMENT", productWork: true }).allowed, false);
  assert.equal(directWriteDecision({ taskAction: "MECHANICAL_FIX", productWork: false, changedFiles: 1, changedLines: 3, deterministic: true, behavioralChange: false, technicalDecision: false }).allowed, true);
});

test("implementation handoff always names Luna as executor", () => {
  const handoff = createImplementationHandoff({
    taskDomain: "AUTOEQ_ALGORITHM",
    rootCauseDecision: "Strategy is settled",
    implementationPlan: ["Apply bounded correction"],
    acceptanceCriteria: ["Focused test passes"],
    testsRequired: ["pnpm test"],
    doNotChange: ["vendor/**"],
  });
  assert.equal(handoff.taskAction, "IMPLEMENT");
  assert.equal(handoff.profile, "luna-max");
  assert.equal(handoff.owner, "luna");
  assert.equal(handoff.scopeContract.taskDomain, "AUTOEQ_ALGORITHM");
});

test("Codex route firewall rejects non-Codex models and workers", () => {
  assert.equal(validateCodexRoute({ model: "gemini-3.8-flash-high", executor: "flash-worker" }).valid, false);
  assert.equal(validateCodexRoute({ model: "gpt-5.6-luna", executor: "flash" }).valid, false);
  assert.equal(validateCodexRoute({ model: "gpt-5.6-luna", executor: "luna-max" }).valid, true);
  assert.equal(validateCodexRoute({ model: "gpt-6-astra", executor: "astra-manual", automatic: true }).valid, false);
});

test("Codex operational files have no dependency on the AGY control plane", () => {
  const scan = scanCodexOperationalFiles();
  assert.deepEqual(scan.violations, []);
  assert.equal(scan.checked > 0, true);
});

test("project config disables every AGY-only skill by official name selector", () => {
  const scan = scanCodexSkillIsolation();
  assert.equal(scan.valid, true);
  assert.deepEqual(scan.missing, []);
});


test("direct operational actions stay with Terra and bypass worker acceptance", () => {
  const route = decideRoute({ taskAction: "DIRECT_ACTION", operation: "SHOW_STATUS" });
  assert.equal(route.profile, "terra-medium");
  assert.equal(route.directAction, true);
  assert.equal(route.bypassesImplementationAcceptance, true);
  assert.equal(isDirectAction({ taskAction: "DIRECT_ACTION", operation: "SHOW_STATUS" }), true);
  assert.equal(canWorkerSpawn(route.profile), false);
  assert.equal(evaluateDirectAction({
    taskAction: "DIRECT_ACTION",
    operation: "SHOW_STATUS",
    commandResult: { command: "git status --porcelain", exit_code: 0, stdout: "" },
  }).complete, true);
  assert.equal(evaluateDirectAction({ taskAction: "DIRECT_ACTION", operation: "SHOW_STATUS", exitCode: 182 }).result, "DIRECT_ACTION_BLOCKED");
  assert.equal(DIRECT_ACTIONS.includes("RUN_TEST"), true);
  assert.equal(decideRoute({ taskAction: "DIRECT_ACTION", operation: "DELETE_EVERYTHING" }).valid, false);
});

test("command result truthfulness: successful empty git status is CLEAN", () => {
  assert.equal(COMMAND_SEMANTICS.includes("UNKNOWN"), true);
  const result = evaluateCommandResult({
    command: "git status --porcelain",
    exit_code: 0,
    stdout: "",
  }, "SHOW_STATUS");
  assert.equal(result.success, true);
  assert.equal(result.stdout_available, true);
  assert.equal(result.semantic_result, "CLEAN");
  assert.equal(result.blocked, false);
});

test("command result truthfulness: exit 182 with empty output is UNKNOWN/BLOCKED", () => {
  const result = evaluateCommandResult({
    command: "git status --porcelain",
    exit_code: 182,
    stdout: "",
  }, "SHOW_STATUS");
  assert.equal(result.success, false);
  assert.equal(result.semantic_result, "UNKNOWN");
  assert.equal(result.blocked, true);
  assert.notEqual(result.semantic_result, "CLEAN");
});

test("command result truthfulness: failed git diff cannot become no changes", () => {
  const result = evaluateCommandResult({
    command: "git diff --stat",
    exit_code: 1,
    stdout: "",
    stderr: "git failed",
  }, "SHOW_DIFF");
  assert.equal(result.semantic_result, "UNKNOWN");
  assert.equal(result.blocked, true);
  assert.notEqual(result.semantic_result, "NO_CHANGES");
});

test("command result truthfulness: nonzero test command is never PASS", () => {
  const result = evaluateCommandResult({
    command: "pnpm test",
    exit_code: 1,
    stdout: "FAIL",
  }, "RUN_TEST");
  assert.equal(result.semantic_result, "TEST_FAILED");
  assert.notEqual(result.semantic_result, "PASS");
});

test("command result truthfulness: typecheck execution failure is TOOL_FAILURE", () => {
  const result = evaluateCommandResult({
    command: "pnpm typecheck",
    exit_code: null,
    stdout: "",
    tool_error: "spawn bubblewrap: unavailable",
  }, "RUN_TYPECHECK");
  assert.equal(result.semantic_result, "TOOL_FAILURE");
  assert.notEqual(result.semantic_result, "TYPECHECK_FAILURE");
});

test("command result truthfulness: failed commit has no synthesized hash", () => {
  const result = evaluateCommandResult({
    command: "git commit -m test",
    exit_code: 1,
    stdout: "",
    stderr: "nothing to commit",
  }, "COMMIT");
  assert.equal(result.commitCreated, false);
  assert.equal(result.commitHash, null);
  assert.equal(result.semantic_result, "COMMIT_FAILED");
});

test("command result truthfulness: failed push is explicitly false", () => {
  const result = evaluateCommandResult({
    command: "git push",
    exit_code: 1,
    stdout: "",
    stderr: "network unavailable",
  }, "PUSH");
  assert.equal(result.pushSucceeded, false);
  assert.equal(result.semantic_result, "PUSH_FAILED");
});

test("command result truthfulness: commit is retained when push fails", () => {
  const result = evaluateCommandResult({
    operation: "COMMIT_PUSH",
    commitResult: {
      command: "git commit -m test",
      exit_code: 0,
      stdout: "[main abc1234] test",
      commit_hash: "abc1234",
    },
    pushResult: {
      command: "git push",
      exit_code: 1,
      stdout: "",
      stderr: "network unavailable",
    },
  }, "COMMIT_PUSH");
  assert.equal(result.commitCreated, true);
  assert.equal(result.commitHash, "abc1234");
  assert.equal(result.pushSucceeded, false);
  assert.equal(result.semantic_result, "PARTIAL_SUCCESS");
});

test("command result truthfulness: unknown tool result fails closed", () => {
  const result = evaluateCommandResult({}, "SHOW_STATUS");
  assert.equal(result.success, false);
  assert.equal(result.semantic_result, "UNKNOWN");
  assert.equal(result.blocked, true);
  assert.equal(evaluateDirectAction({
    taskAction: "DIRECT_ACTION",
    operation: "SHOW_STATUS",
    commandResult: {},
  }).result, "DIRECT_ACTION_BLOCKED");
});

test("command result truthfulness: contradictory success metadata fails closed", () => {
  const result = evaluateCommandResult({
    command: "git status --porcelain",
    exit_code: 0,
    success: false,
    stdout: "",
  }, "SHOW_STATUS");
  assert.equal(result.semantic_result, "UNKNOWN");
  assert.equal(result.blocked, true);
});

test("command result truthfulness: Codex event failure cannot be overridden by a clean model message", () => {
  const events = [
    { type: "item.completed", item: {
      type: "command_execution",
      command: "/bin/bash -lc 'git status --short'",
      aggregated_output: "",
      exit_code: 182,
      status: "failed",
    } },
    { type: "item.completed", item: {
      type: "agent_message",
      text: "Working tree clean.",
    } },
  ];
  const result = evaluateCodexExecEvents(events, "SHOW_STATUS");
  assert.equal(result.semantic_result, "UNKNOWN");
  assert.equal(result.blocked, true);
  assert.equal(result.modelConclusionTrusted, false);
  assert.match(result.report, /Unable to determine repository status because the command failed/);
});

test("command result truthfulness: a known dirty result rejects a contradictory clean claim", () => {
  const result = evaluateCodexExecEvents([
    { type: "item.completed", item: {
      type: "command_execution",
      command: "/bin/bash -lc 'git status --short'",
      aggregated_output: " M .codex/astra-orchestra/routing-policy.mjs\n",
      exit_code: 0,
      status: "completed",
    } },
    { type: "item.completed", item: { type: "agent_message", text: "Working tree clean." } },
  ], "SHOW_STATUS");
  assert.equal(result.semantic_result, "DIRTY");
  assert.equal(result.modelConclusionTrusted, false);
  assert.equal(result.report, "Working tree has changes.");
});

test("Luna Medium is limited to explicit non-product deterministic support", () => {
  const support = decideRoute({
    taskAction: "MECHANICAL_FIX", taskDomain: "DOCS", deterministicSupport: true, productWork: false,
  });
  assert.equal(support.profile, "luna-medium");
  const product = decideRoute({
    taskAction: "MECHANICAL_FIX", taskDomain: "DOCS", deterministicSupport: true, productWork: true,
  });
  assert.equal(product.profile, "luna-high");
  assert.equal(decideRoute({ taskAction: "IMPLEMENT", taskDomain: "DOCS", implementationComplexity: "normal" }).profile, "luna-max");
});

test("worker completion is a compact summary with no self-acceptance", () => {
  const valid = validateWorkerCompletion({
    status: "IMPLEMENTATION_COMPLETE", changedFiles: ["docs/codex/x.md"], changeSummary: "x",
    validation: ["node --test: pass"], risks: [], blockers: [], scopeResult: "compliant",
  });
  assert.equal(valid.valid, true);
  assert.equal(validateWorkerCompletion({ status: "IMPLEMENTATION_COMPLETE" }).valid, false);
  assert.equal(canWorkerAccept("luna-medium"), false);
});

test("Codex action vocabulary is explicit and provider-independent", () => {
  assert.equal(ACTIONS.includes("IMPLEMENT"), true);
  assert.equal(ACTIONS.includes("INVESTIGATE"), true);
  assert.equal(ACTIONS.includes("DIRECT_ACTION"), true);
  assert.equal(Object.values(CODEX_MODELS).some((entry) => entry.model.includes("gemini")), false);
});

test("instruction source remains within the Codex control-plane tree", () => {
  const instructions = readFileSync(new URL("./INSTRUCTIONS.md", import.meta.url), "utf8");
  assert.equal(instructions.includes("Terra Medium"), true);
  assert.equal(instructions.includes(".agents/skills/agy-orchestra"), false);
  assert.equal(instructions.includes("gemini-"), false);
});

test("provider-neutral scope contract preserves side-effect capabilities", () => {
  const contract = createScopeContract({
    allowedPaths: ["packages/core/**"],
    capabilities: ["network_write", "VCS_REMOTE_WRITE", "network_write"],
  });
  assert.deepEqual(contract.sideEffectCapabilities, ["NETWORK_WRITE", "VCS_REMOTE_WRITE"]);
  assert.equal(validateScopeContract(contract, ["packages/core/src/index.ts"]).valid, true);

  const nested = createScopeContract({
    scopeContract: {
      allowedPaths: ["packages/core/**"],
      sideEffectCapabilities: ["PUBLICATION"],
    },
  });
  assert.deepEqual(nested.sideEffectCapabilities, ["PUBLICATION"]);

  const invalid = validateScopeContract({
    allowedPaths: ["packages/core/**"],
    sideEffectCapabilities: ["ROOT_ACCESS"],
  }, ["packages/core/src/index.ts"]);
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.invalidSideEffectCapabilities, ["ROOT_ACCESS"]);
});
