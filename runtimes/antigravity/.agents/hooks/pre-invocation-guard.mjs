import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import {
  deliverPendingAdvisories,
  consumeDeliveredAdvisories,
} from "../skills/agy-orchestra/routing-policy.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function getWorkspacePaths(payload = {}) {
  const cwd = process.cwd();
  let repoRoot;
  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) {
    repoRoot = resolve(payload.workspacePaths[0]);
  } else if (basename(cwd) === ".agents") {
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
    telemetryPath: resolve(repoRoot, ".agents/telemetry/events.jsonl"),
  };
}

function main() {
  const rawInput = readStdin();
  let payload = {};
  if (rawInput.trim()) {
    try {
      payload = JSON.parse(rawInput);
    } catch {}
  }

  const { statePath, telemetryPath } = getWorkspacePaths(payload);
  const injectSteps = [];

  let state = {};
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {}
  }

  const benchmarkRunId = process.env.BENCHMARK_RUN_ID || payload.benchmarkRunId || state.benchmarkRunId || null;
  const taskId = process.env.BENCHMARK_TASK_ID || payload.taskId || state.taskId || null;
  if (benchmarkRunId) state.benchmarkRunId = benchmarkRunId;
  if (taskId) state.taskId = taskId;

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
