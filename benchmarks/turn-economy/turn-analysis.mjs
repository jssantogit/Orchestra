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

  return {
    model_turns_total: modelTurnsTotal,
    tool_calls_per_turn_distribution: toolCallsPerTurnDistribution,
    tools_per_turn_list: toolsPerTurnList,
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
  };
}
