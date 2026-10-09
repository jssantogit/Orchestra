/**
 * Turn Economy Analysis & Role-Aware Invocation Model for Orchestra.
 *
 * Implements:
 * - Observable model turn boundary definitions
 * - Role-aware invocation tracking (ORCHESTRATOR, WORKER, REVIEWER, INVESTIGATOR, DIRECT_ACTION, UNKNOWN)
 * - Tools-per-turn distribution (0, 1, 2, 3+)
 * - Pre-mutation turns and tool sequence decomposition
 * - Observational tool redundancy detection
 */

export const ROLES = Object.freeze({
  ORCHESTRATOR: "ORCHESTRATOR",
  WORKER: "WORKER",
  REVIEWER: "REVIEWER",
  INVESTIGATOR: "INVESTIGATOR",
  DIRECT_ACTION: "DIRECT_ACTION",
  UNKNOWN: "UNKNOWN",
});

const FOUNDATION_METRIC_FIELDS = Object.freeze([
  "control_turns",
  "worker_turns",
  "repository_discovery_ops",
  "redundant_reads",
  "turns_to_first_edit",
  "delegations",
  "model_handoffs",
  "approximate_cost",
]);

function finiteMetric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Adds the Core Foundation metric vocabulary to a turn-economy result.
 * Missing historical data stays null unless an existing field measures the
 * same quantity directly.
 *
 * @param {Object} metrics - A current or historical turn-economy result
 * @returns {Object} A copy of the result with all foundation metrics present
 */
export function normalizeTurnEconomyMetrics(metrics = {}) {
  const result = { ...metrics };
  const repeatedReadReasons = new Set([
    "whole_file_read_after_targeted_read",
    "same_file_read_repeatedly_without_mutation",
  ]);

  const knownRedundantReads = Array.isArray(metrics.potentiallyAvoidableToolCalls)
    ? metrics.potentiallyAvoidableToolCalls.filter((call) => repeatedReadReasons.has(call.reason)).length
    : null;
  const knownControlTurns = finiteMetric(metrics.parent_model_turns);
  const knownWorkerTurns = finiteMetric(metrics.worker_model_turns);
  const knownDiscoveryOps = (
    finiteMetric(metrics.parent_repository_search_attempts) !== null &&
    finiteMetric(metrics.worker_repository_search_attempts) !== null
  )
    ? metrics.parent_repository_search_attempts + metrics.worker_repository_search_attempts
    : null;

  const values = {
    control_turns: finiteMetric(metrics.control_turns) ?? knownControlTurns,
    worker_turns: finiteMetric(metrics.worker_turns) ?? knownWorkerTurns,
    repository_discovery_ops: finiteMetric(metrics.repository_discovery_ops) ?? knownDiscoveryOps,
    redundant_reads: finiteMetric(metrics.redundant_reads) ?? knownRedundantReads,
    turns_to_first_edit: finiteMetric(metrics.turns_to_first_edit) ?? finiteMetric(metrics.first_mutation_turn),
    delegations: finiteMetric(metrics.delegations) ?? finiteMetric(metrics.subagent_invocations),
    model_handoffs: finiteMetric(metrics.model_handoffs),
    approximate_cost: finiteMetric(metrics.approximate_cost),
  };

  for (const field of FOUNDATION_METRIC_FIELDS) {
    result[field] = values[field];
  }
  return result;
}

/**
 * Analyzes an Antigravity transcript or telemetry event sequence.
 *
 * @param {Array<Object>} steps - List of transcript steps or raw events
 * @param {Object} [activeState={}] - The active state from .agents/state/active-state.json
 */
export function analyzeAgyConversation(steps = [], activeState = {}) {
  let modelTurnsTotal = 0;
  let turnsWithZeroTools = 0;
  let turnsWithOneTool = 0;
  let turnsWithMultipleTools = 0;
  let maxToolsInSingleTurn = 0;

  const toolCallsPerTurnDistribution = { 0: 0, 1: 0, 2: 0, "3+": 0 };
  const toolsPerTurnList = [];

  let firstMutationTurn = null;
  let lastMutationTurn = null;
  let currentTurnIndex = 0;

  let preMutationTurns = 0;
  let postMutationTurns = 0;
  let validationTurns = 0;

  let preMutationToolCalls = 0;
  let preMutationReadCalls = 0;
  let preMutationSearchCalls = 0;
  let preMutationValidationCalls = 0;
  let repositoryDiscoveryOps = 0;
  let observedDelegations = 0;

  const roleInvocations = {
    orchestrator: 0,
    worker: 0,
    reviewer: 0,
    investigator: 0,
    direct_action: 0,
    unknown: 0,
  };

  const fileReadHistory = new Map(); // path -> Array<{ lineWindow, turnIndex }>
  const gitInspections = [];
  const potentiallyAvoidableToolCalls = [];

  let sawImplementationRead = false;
  let mutationOccurred = false;

  // Track subagents
  const subagentInvocations = activeState.subagent_invocations || 0;
  const workerInvocations = activeState.worker_invocations || 0;
  const reviewerInvocations = activeState.reviewer_invocations || 0;

  // Determine primary task role
  const isDirectAction = activeState.taskAction === "DIRECT_ACTION" || activeState.isDirectAction === true;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type === "PLANNER_RESPONSE" && step.source === "MODEL") {
      modelTurnsTotal++;
      currentTurnIndex = modelTurnsTotal;

      const tcs = step.tool_calls || [];
      const toolCount = tcs.length;
      toolsPerTurnList.push(toolCount);

      if (toolCount === 0) {
        turnsWithZeroTools++;
        toolCallsPerTurnDistribution[0]++;
      } else if (toolCount === 1) {
        turnsWithOneTool++;
        toolCallsPerTurnDistribution[1]++;
      } else if (toolCount === 2) {
        turnsWithMultipleTools++;
        toolCallsPerTurnDistribution[2]++;
      } else {
        turnsWithMultipleTools++;
        toolCallsPerTurnDistribution["3+"]++;
      }

      if (toolCount > maxToolsInSingleTurn) {
        maxToolsInSingleTurn = toolCount;
      }

      let turnHasValidation = false;
      let turnHasMutation = false;

      for (const tc of tcs) {
        const name = tc.name || tc.function?.name || "unknown";
        const args = tc.args || tc.parameters || {};

        // Classify tool action
        const isRead = name === "view_file" || name === "list_dir";
        const isSearch = name === "grep_search" || name === "find_by_name";
        const isEdit = name === "replace_file_content" || name === "write_to_file";
        const isShell = name === "run_command";

        if (isSearch) repositoryDiscoveryOps++;
        if (name === "invoke_subagent") {
          const requestedSubagents = args.Subagents;
          observedDelegations += Array.isArray(requestedSubagents) ? requestedSubagents.length : 1;
        }

        let isValidation = false;
        let isShellMutation = false;

        if (isShell) {
          const cmd = String(args.CommandLine || args.cmd || "");
          if (/^(?:npm\s+(?:run\s+)?test|pnpm\s+test|node\s+--test|pytest|cargo\s+test)\b/.test(cmd.trim())) {
            isValidation = true;
          }
          if (/\b(?:git\s+commit|git\s+push|rm\s|touch\s|sed\s+-i)\b/.test(cmd)) {
            isShellMutation = true;
          }
          if (/\bgit\s+(?:status|diff|log|branch)\b/.test(cmd)) {
            gitInspections.push({ turnIndex: currentTurnIndex, cmd });
            if (gitInspections.length > 2) {
              potentiallyAvoidableToolCalls.push({
                toolName: name,
                args: { cmd },
                turnIndex: currentTurnIndex,
                reason: "repeated_git_inspection",
              });
            }
          }
        }

        const isMutation = isEdit || isShellMutation;

        if (isMutation) {
          turnHasMutation = true;
          if (!mutationOccurred) {
            mutationOccurred = true;
            firstMutationTurn = currentTurnIndex;
          }
          lastMutationTurn = currentTurnIndex;
        }

        if (isValidation) {
          turnHasValidation = true;
        }

        // Redundancy check: Repeated file reading without mutation
        if (name === "view_file") {
          const path = args.AbsolutePath || args.path || "unknown";
          const start = args.StartLine;
          const end = args.EndLine;
          const isFull = (start === undefined && end === undefined);

          if (path.includes("src/") || path.includes("lib/")) {
            sawImplementationRead = true;
          }

          if (fileReadHistory.has(path)) {
            const priorReads = fileReadHistory.get(path);
            const hadMutationSince = priorReads.some(r => r.turnIndex >= (firstMutationTurn || Infinity));
            if (!hadMutationSince && !mutationOccurred) {
              potentiallyAvoidableToolCalls.push({
                toolName: name,
                args: { path, start, end },
                turnIndex: currentTurnIndex,
                reason: isFull ? "whole_file_read_after_targeted_read" : "same_file_read_repeatedly_without_mutation",
              });
            }
            priorReads.push({ isFull, start, end, turnIndex: currentTurnIndex });
          } else {
            fileReadHistory.set(path, [{ isFull, start, end, turnIndex: currentTurnIndex }]);
          }
        }

        // Redundancy check: Test run before inspecting implementation
        if (isValidation && !sawImplementationRead && !mutationOccurred) {
          potentiallyAvoidableToolCalls.push({
            toolName: name,
            args,
            turnIndex: currentTurnIndex,
            reason: "test_run_before_inspecting_implementation",
          });
        }

        // Pre-mutation counters
        if (!mutationOccurred) {
          preMutationToolCalls++;
          if (isRead) preMutationReadCalls++;
          if (isSearch) preMutationSearchCalls++;
          if (isValidation) preMutationValidationCalls++;
        }
      }

      if (turnHasValidation) {
        validationTurns++;
      }
    }
  }

  // Pre vs post mutation turn calculation
  if (firstMutationTurn !== null) {
    preMutationTurns = firstMutationTurn - 1;
    postMutationTurns = Math.max(0, modelTurnsTotal - lastMutationTurn);
  } else {
    preMutationTurns = modelTurnsTotal;
    postMutationTurns = 0;
  }

  // Role attribution
  if (isDirectAction) {
    roleInvocations.direct_action = modelTurnsTotal;
  } else if (subagentInvocations > 0) {
    roleInvocations.orchestrator = Math.max(0, modelTurnsTotal - workerInvocations - reviewerInvocations);
    roleInvocations.worker = workerInvocations;
    roleInvocations.reviewer = reviewerInvocations;
  } else {
    // If no subagents were spawned, all observed turns executed in orchestrator / main agent
    roleInvocations.orchestrator = modelTurnsTotal;
  }

  // Enforce Distribution Invariant: sum of distribution buckets == model_turns_total
  const distSum = toolCallsPerTurnDistribution[0] + toolCallsPerTurnDistribution[1] + toolCallsPerTurnDistribution[2] + toolCallsPerTurnDistribution["3+"];
  if (distSum !== modelTurnsTotal) {
    throw new Error(`Distribution invariant failed: sum(${toolCallsPerTurnDistribution[0]}, ${toolCallsPerTurnDistribution[1]}, ${toolCallsPerTurnDistribution[2]}, ${toolCallsPerTurnDistribution["3+"]}) = ${distSum} !== modelTurnsTotal (${modelTurnsTotal})`);
  }

  // Enforce Tool Count Invariant: total tool calls == sum of toolsPerTurnList
  const totalTools = toolsPerTurnList.reduce((acc, count) => acc + count, 0);
  const sum3Plus = toolsPerTurnList.filter(c => c >= 3).reduce((acc, count) => acc + count, 0);
  const derivedToolSum = (1 * toolCallsPerTurnDistribution[1]) + (2 * toolCallsPerTurnDistribution[2]) + sum3Plus;
  if (derivedToolSum !== totalTools) {
    throw new Error(`Tool count invariant failed: derivedToolSum ${derivedToolSum} !== totalTools ${totalTools}`);
  }

  const knownDelegations = finiteMetric(activeState.subagent_invocations) ?? observedDelegations;
  const hasDelegatedWorkers = knownDelegations > 0 || workerInvocations > 0 || reviewerInvocations > 0;
  const explicitControlTurns = finiteMetric(activeState.control_turns) ?? finiteMetric(activeState.parent_model_turns);

  return normalizeTurnEconomyMetrics({
    model_turns_total: modelTurnsTotal,
    total_tool_calls: totalTools,
    tool_calls_per_turn_distribution: toolCallsPerTurnDistribution,
    tools_per_turn_list: toolsPerTurnList,
    per_turn_tool_counts: toolsPerTurnList,
    turns_with_zero_tools: turnsWithZeroTools,
    turns_with_one_tool: turnsWithOneTool,
    turns_with_multiple_tools: turnsWithMultipleTools,
    max_tools_in_single_turn: maxToolsInSingleTurn,
    multi_tool_same_turn_supported: maxToolsInSingleTurn >= 2,
    pre_mutation_turns: preMutationTurns,
    post_mutation_turns: postMutationTurns,
    validation_turns: validationTurns,
    preMutationToolCalls,
    preMutationReadCalls,
    preMutationSearchCalls,
    preMutationValidationCalls,
    potentiallyAvoidableToolCalls,
    role_invocations: roleInvocations,
    control_turns: explicitControlTurns ?? (hasDelegatedWorkers ? null : modelTurnsTotal),
    worker_turns: activeState.worker_model_turns,
    repository_discovery_ops: repositoryDiscoveryOps,
    redundant_reads: potentiallyAvoidableToolCalls.filter((call) => [
      "whole_file_read_after_targeted_read",
      "same_file_read_repeatedly_without_mutation",
    ].includes(call.reason)).length,
    turns_to_first_edit: firstMutationTurn,
    delegations: knownDelegations,
    model_handoffs: null,
    approximate_cost: null,
  });
}
