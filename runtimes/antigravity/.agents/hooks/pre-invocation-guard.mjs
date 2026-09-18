import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deliverPendingAdvisories,
  consumeDeliveredAdvisories,
} from "../skills/agy-orchestra/routing-policy.mjs";
import {
  createContinuationCapsule,
  formatContinuationCapsule,
} from "../skills/orchestra/trust-boundary.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function parseWorkspacePath(p) {
  if (!p || typeof p !== "string") return "";
  if (p.startsWith("file://")) {
    try {
      return fileURLToPath(p);
    } catch {
      return p.replace(/^file:\/\/\/?/, "");
    }
  }
  return p;
}

function getWorkspacePaths(payload = {}) {
  const cwd = process.cwd();
  let repoRoot;
  const rawWs = (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0])
    || (Array.isArray(payload.workspaceUris) && payload.workspaceUris[0])
    || null;
  if (rawWs) {
    repoRoot = resolve(parseWorkspacePath(rawWs));
  } else if (basename(cwd) === ".agents") {
    repoRoot = resolve(cwd, "..");
  } else if (existsSync(resolve(cwd, ".agents"))) {
    repoRoot = cwd;
  } else if (existsSync(resolve(cwd, "../.agents"))) {
    repoRoot = resolve(cwd, "..");
  } else if (existsSync(resolve(cwd, "packages"))) {
    repoRoot = cwd;
  } else if (existsSync(resolve(cwd, "../packages"))) {
    repoRoot = resolve(cwd, "..");
  } else {
    repoRoot = cwd;
  }
  return {
    repoRoot,
    statePath: resolve(repoRoot, ".agents/state/active-state.json"),
    contractPath: resolve(repoRoot, ".agents/state/active-contract.json"),
    roleBindingsPath: resolve(repoRoot, ".agents/state/role-bindings.json"),
    telemetryPath: resolve(repoRoot, ".agents/telemetry/events.jsonl"),
  };
}

function readGovernanceObject(path, label) {
  if (!existsSync(path)) return { ok: true, exists: false, value: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { ok: false, exists: true, value: null, reason: `${label}_MALFORMED_JSON` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, exists: true, value: null, reason: `${label}_INVALID_SHAPE` };
  }
  return { ok: true, exists: true, value: parsed };
}

function validRoleBindingsShape(roleBindings) {
  if (!roleBindings || typeof roleBindings !== "object" || Array.isArray(roleBindings)) return false;
  if (
    roleBindings.mainConversationId !== undefined &&
    roleBindings.mainConversationId !== null &&
    typeof roleBindings.mainConversationId !== "string"
  ) return false;
  if (
    roleBindings.bindings !== undefined &&
    (!roleBindings.bindings || typeof roleBindings.bindings !== "object" || Array.isArray(roleBindings.bindings))
  ) return false;
  if (
    roleBindings.conversations !== undefined &&
    (!roleBindings.conversations || typeof roleBindings.conversations !== "object" || Array.isArray(roleBindings.conversations))
  ) return false;
  if (roleBindings.pendingSubagents !== undefined && !Array.isArray(roleBindings.pendingSubagents)) return false;
  return true;
}

function main() {
  const rawInput = readStdin();
  let payload = {};
  if (rawInput.trim()) {
    try {
      payload = JSON.parse(rawInput);
    } catch {
      console.log(JSON.stringify({
        injectSteps: [{
          ephemeralMessage: "GOVERNANCE STATE WARNING: PreInvocation payload was malformed. No authority state was modified; tool execution will fail closed until the runtime provides a valid payload."
        }]
      }));
      return;
    }
  }

  const { statePath, contractPath, roleBindingsPath, telemetryPath } = getWorkspacePaths(payload);
  const injectSteps = [];

  let state = {};
  const stateLoad = readGovernanceObject(statePath, "ACTIVE_STATE");
  if (!stateLoad.ok) {
    try {
      mkdirSync(dirname(telemetryPath), { recursive: true });
      appendFileSync(telemetryPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "GOVERNANCE_STATE_CORRUPT",
        phase: "PRE_INVOCATION",
        reason: stateLoad.reason,
        conversationId: payload.conversationId || null,
      }) + "\n", "utf-8");
    } catch {}
    console.log(JSON.stringify({
      injectSteps: [{
        ephemeralMessage: `GOVERNANCE STATE INVALID: ${stateLoad.reason}. Authority state was preserved unchanged. Do not execute tools until governance state is repaired.`
      }]
    }));
    return;
  }
  if (stateLoad.exists) state = stateLoad.value;

  const benchmarkRunId = process.env.BENCHMARK_RUN_ID || payload.benchmarkRunId || state.benchmarkRunId || null;
  const taskId = process.env.BENCHMARK_TASK_ID || payload.taskId || state.taskId || null;
  if (benchmarkRunId) state.benchmarkRunId = benchmarkRunId;
  if (taskId) state.taskId = taskId;

  // Bootstrap role-bindings for root orchestrator if not yet initialized
  let roleBindings = { mainConversationId: null, bindings: {}, conversations: {}, pendingSubagents: [] };
  const roleBindingsLoad = readGovernanceObject(roleBindingsPath, "ROLE_BINDINGS");
  if (!roleBindingsLoad.ok || (roleBindingsLoad.exists && !validRoleBindingsShape(roleBindingsLoad.value))) {
    const reason = roleBindingsLoad.ok ? "ROLE_BINDINGS_INVALID_SHAPE" : roleBindingsLoad.reason;
    try {
      mkdirSync(dirname(telemetryPath), { recursive: true });
      appendFileSync(telemetryPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "GOVERNANCE_STATE_CORRUPT",
        phase: "PRE_INVOCATION",
        reason,
        conversationId: payload.conversationId || null,
      }) + "\n", "utf-8");
    } catch {}
    console.log(JSON.stringify({
      injectSteps: [{
        ephemeralMessage: `GOVERNANCE STATE INVALID: ${reason}. Role identity state was preserved unchanged. Do not execute tools until governance state is repaired.`
      }]
    }));
    return;
  }
  if (roleBindingsLoad.exists) roleBindings = roleBindingsLoad.value;

  const convId = payload.conversationId || null;
  const knownMainConversationId = roleBindings.mainConversationId || state.conversationId || null;
  const hasPendingDelegations = Array.isArray(roleBindings.pendingSubagents)
    && roleBindings.pendingSubagents.some((p) => !p?.consumed);

  if (convId && !roleBindings.mainConversationId) {
    const conflictsWithKnownMain = Boolean(
      knownMainConversationId && convId !== knownMainConversationId
    );

    if (!conflictsWithKnownMain && !hasPendingDelegations) {
      roleBindings.mainConversationId = convId;
      if (!roleBindings.bindings) roleBindings.bindings = {};
      if (!roleBindings.conversations) roleBindings.conversations = {};
      const orchRecord = {
        role: "ORCHESTRATOR",
        profile: "flash-orchestrator",
        model: payload.modelName || "gemini-3.8-flash-medium",
        source: "RUNTIME_BOOTSTRAP",
        confidence: "HIGH",
      };
      roleBindings.bindings[convId] = orchRecord;
      roleBindings.conversations[convId] = orchRecord;
      state.conversationId = state.conversationId || convId;
      try {
        mkdirSync(dirname(roleBindingsPath), { recursive: true });
        writeFileSync(roleBindingsPath, JSON.stringify(roleBindings, null, 2), "utf-8");
      } catch {}
    } else {
      state.identityBootstrapRejected = {
        conversationId: convId,
        knownMainConversationId,
        reason: conflictsWithKnownMain ? "KNOWN_MAIN_MISMATCH" : "PENDING_DELEGATIONS_EXIST",
        timestamp: new Date().toISOString(),
      };
    }
  }

  if (!state.activeRole && !state.role) {
    state.activeRole = "ORCHESTRATOR";
    state.agentProfile = "flash-orchestrator";
    state.orchestratorModel = payload.modelName || "gemini-3.8-flash-medium";
  }

  let capsuleContract = state.scopeContract || {};
  const contractLoad = readGovernanceObject(contractPath, "ACTIVE_CONTRACT");
  if (!contractLoad.ok) {
    console.log(JSON.stringify({
      injectSteps: [{
        ephemeralMessage: `GOVERNANCE STATE INVALID: ${contractLoad.reason}. Scope authority could not be reconstructed; do not execute tools until repaired.`
      }]
    }));
    return;
  }
  if (contractLoad.exists) capsuleContract = contractLoad.value;

  const continuationCapsule = createContinuationCapsule({
    activeState: state,
    activeContract: capsuleContract,
    roleBindings,
  });
  state.continuationCapsuleId = continuationCapsule.capsule_id;
  state.continuation_capsule_injections = (state.continuation_capsule_injections || 0) + 1;
  injectSteps.push({ ephemeralMessage: formatContinuationCapsule(continuationCapsule) });

  // Turn Economy: observational counters
  state.preinvocation_count = (state.preinvocation_count || 0) + 1;
  state.model_invocations = state.preinvocation_count;

  // Context proxy bytes from observable payload
  const rawInputBytes = Buffer.byteLength(rawInput || "", "utf-8");
  state.context_proxy_bytes = (state.context_proxy_bytes || 0) + rawInputBytes;
  state.advisory_injections_by_type = state.advisory_injections_by_type || {};

  let stateModified = true;

  // 1. Consume previously delivered advisories so they are never re-injected
  const consumedCount = consumeDeliveredAdvisories(state);
  if (consumedCount > 0) {
    stateModified = true;
  }

  // 2. Deliver any pending advisories
  const delivered = deliverPendingAdvisories(state);
  if (delivered.length > 0) {
    stateModified = true;
    for (const adv of delivered) {
      injectSteps.push({ ephemeralMessage: adv.message });
      const advType = adv.type || adv.category || "GENERAL";
      state.advisory_injections_total = (state.advisory_injections_total || 0) + 1;
      state.advisory_injections_by_type[advType] = (state.advisory_injections_by_type[advType] || 0) + 1;
    }
  }

  function recordAdvisory(type, message) {
    injectSteps.push({ ephemeralMessage: message });
    state.advisory_injections_total = (state.advisory_injections_total || 0) + 1;
    state.advisory_injections_by_type[type] = (state.advisory_injections_by_type[type] || 0) + 1;
  }

  // 3. Existing circuit breaker warnings
  if (state.loopSuspected || state.circuitBreakerType === "LOOP_SUSPECTED") {
    recordAdvisory("LOOP_SUSPECTED", "LOOP CIRCUIT BREAKER: Repeated file reads detected without state progress. Do not re-read files; synthesize findings or transition to HUMAN_GATE.");
  }

  if (state.stalled || state.circuitBreakerType === "STALLED") {
    recordAdvisory("STALLED", "STALLED CIRCUIT BREAKER: Repeated identical tool executions or retry reasons detected without forward progress. Halt and generate UNRESOLVED_DECISION_PACKET for HUMAN_GATE.");
  }

  if (state.coordinationOverheadDetected || state.circuitBreakerType === "COORDINATION_OVERHEAD") {
    recordAdvisory("COORDINATION_OVERHEAD", "COORDINATION OVERHEAD DETECTED: Multiple retries or excessive orchestration turns recorded. Ensure delta handoff is compact, root cause is isolated, or halt to HUMAN_GATE.");
  }

  if (state.contextBloatDetected || state.circuitBreakerType === "CONTEXT_BLOAT") {
    recordAdvisory("CONTEXT_BLOAT", "CONTEXT BLOAT WARNING: Output or handoff size is high. Compress logs, omit repetitive code, and transfer only essential facts.");
  }

  if (state.humanGateRequired || state.state === "HUMAN_GATE") {
    recordAdvisory("HUMAN_GATE", "HUMAN GATE ACTIVE: Automation cannot safely resolve current state. Stop tool execution and present UNRESOLVED_DECISION_PACKET to user.");
  }

  if (state.state === "CI_WAIT") {
    const nextPollAt = state.ciWait?.nextPollAt || state.ciWait?.watchSummary?.watches?.[0]?.nextPollAt || "pending";
    const runner = state.ciWait?.runner?.pid
      ? "background runner pid=" + state.ciWait.runner.pid
      : (state.ciWait?.runner?.disabled ? "background runner disabled" : "watch persisted");
    recordAdvisory(
      "CI_WAIT",
      "CI_WAIT ACTIVE: authoritative remote evidence is pending; " + runner + ", nextPollAt=" + nextPollAt + ". Do not substitute local tests, inspect unrelated files, spawn subagents, or model-poll CI. Yield with zero work."
    );
  }

  if (state.mechanicalFastPath?.active === true) {
    const paths = Array.isArray(state.mechanicalFastPath.allowedPaths)
      ? state.mechanicalFastPath.allowedPaths.join(", ")
      : "";
    recordAdvisory(
      "MECHANICAL_FAST_PATH",
      "MECHANICAL FAST PATH ACTIVE: one Flash Low worker, concrete scope [" + paths + "]. Read only declared targets, perform the bounded native edit, skip search/shell/review/extra subagents, then hand off. Runtime-owned LOCAL_FACT evidence will be collected by Orchestra."
    );
  }

  if (state.directActionOverheadDetected || state.circuitBreakerType === "DIRECT_ACTION_OVERHEAD") {
    recordAdvisory("DIRECT_ACTION_OVERHEAD", "DIRECT_ACTION_OVERHEAD: Target for direct action is 1-3 tool calls. Consolidate operations via git-operation.mjs or execute command directly.");
  }

  if (state.directActionOverthinkingDetected || state.circuitBreakerType === "DIRECT_ACTION_OVERTHINKING") {
    recordAdvisory("DIRECT_ACTION_OVERTHINKING", "DIRECT_ACTION_OVERTHINKING: Multiple model turns elapsed on direct operational action. Conclude execution without additional deliberation.");
  }

  if (state.shellOveruseDetected && !state.shellOveruseAdvised) {
    recordAdvisory("NATIVE_TOOLS_FIRST", "NATIVE_TOOLS_FIRST: Use view_file / grep_search / find_by_name / edit tools for repository inspection. Reserve run_command for execution or unsupported native queries.");
    state.shellOveruseAdvised = true;
    stateModified = true;
  } else if (!state.shellOveruseDetected && state.shellOveruseAdvised) {
    delete state.shellOveruseAdvised;
    stateModified = true;
  }

  if (stateModified) {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    } catch {}
  }

  // Record PRE_INVOCATION telemetry event
  try {
    mkdirSync(dirname(telemetryPath), { recursive: true });
    const preEvent = {
      timestamp: new Date().toISOString(),
      type: "PRE_INVOCATION",
      preinvocation_count: state.preinvocation_count,
      model_invocations: state.model_invocations,
      invocationNum: payload.invocationNum ?? state.preinvocation_count,
      conversationId: payload.conversationId || state.conversationId || null,
      benchmarkRunId,
      taskId,
      advisory_injections_total: state.advisory_injections_total || 0,
      advisory_injections_by_type: state.advisory_injections_by_type || {},
      injected_advisories_count: injectSteps.length,
      context_proxy_bytes: state.context_proxy_bytes || 0,
    };
    appendFileSync(telemetryPath, JSON.stringify(preEvent) + "\n", "utf-8");
  } catch {}

  console.log(JSON.stringify({ injectSteps }));
}

main();
