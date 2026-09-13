import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import {
  classifyExecutionEvidence,
  classifyShellIntent,
  classifyShellMutation,
  trackGitInspection,
  createInitialToolMix,
  calculateToolMixMetrics,
  detectShellOveruse,
  detectExplorationOverhead,
  recordMutation,
  recordNativeToolFallback,
  detectDirectActionOverhead,
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
    executionsDir: resolve(repoRoot, ".agents/state/executions"),
    pendingExecutionsDir: resolve(repoRoot, ".agents/state/executions/pending"),
  };
}

function main() {
  const rawInput = readStdin();
  if (!rawInput.trim()) {
    console.log(JSON.stringify({}));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }

  try {
    const { repoRoot, statePath, telemetryPath, executionsDir, pendingExecutionsDir } = getWorkspacePaths(payload);
    mkdirSync(dirname(telemetryPath), { recursive: true });

    let activeState = {};
    if (existsSync(statePath)) {
      try {
        activeState = JSON.parse(readFileSync(statePath, "utf-8"));
      } catch {}
    }

    if (!activeState.toolMix) {
      activeState.toolMix = createInitialToolMix();
    }

    const benchmarkRunId = process.env.BENCHMARK_RUN_ID || payload.benchmarkRunId || activeState.benchmarkRunId || null;
    const taskId = process.env.BENCHMARK_TASK_ID || payload.taskId || activeState.taskId || null;
    if (benchmarkRunId) activeState.benchmarkRunId = benchmarkRunId;
    if (taskId) activeState.taskId = taskId;

    // Turn economy: total tool calls & context proxy bytes
    activeState.tool_calls = (activeState.tool_calls || 0) + 1;
    activeState.tool_calls_total = activeState.tool_calls;

    const rawInputBytes = Buffer.byteLength(rawInput || "", "utf-8");
    activeState.context_proxy_bytes = (activeState.context_proxy_bytes || 0) + rawInputBytes;

    let executionRecord = null;
    let recordedEvidence = null;

    const stepIdx = payload.stepIdx ?? null;
    const conversationId = payload.conversationId || "default";

    // 1. Resolve executionId via exact correlation
    let resolvedExecutionId = payload.executionId || null;

    if (!resolvedExecutionId && stepIdx !== null) {
      const pendingKey = `${encodeURIComponent(conversationId)}__${stepIdx}`;
      const pendingFile = resolve(pendingExecutionsDir, `${pendingKey}.json`);
      if (existsSync(pendingFile)) {
        try {
          const pendingData = JSON.parse(readFileSync(pendingFile, "utf-8"));
          if (pendingData && pendingData.executionId) {
            resolvedExecutionId = pendingData.executionId;
          }
          unlinkSync(pendingFile);
        } catch {}
      }
    }

    // Check if toolCall CommandLine had --exec-id
    if (!resolvedExecutionId) {
      const cmdArg = payload.toolCall?.args?.CommandLine || payload.toolCall?.args?.cmd || "";
      const match = cmdArg.match(/--exec-id\s+([^\s]+)/);
      if (match && match[1]) {
        resolvedExecutionId = match[1].replace(/["']/g, "");
      }
    }

    // 2. Load execution record by exact executionId
    if (resolvedExecutionId) {
      const execFilePath = resolve(executionsDir, `${resolvedExecutionId}.json`);
      if (existsSync(execFilePath)) {
        try {
          executionRecord = JSON.parse(readFileSync(execFilePath, "utf-8"));
        } catch {}
      }
    }

    // Track tool mix and mutations
    const toolName = payload.toolName ?? payload.toolCall?.name ?? null;
    const toolArgs = payload.toolCall?.args || {};
    let shellClassification = null;
    let shellMutation = null;

    const isDirectAction = activeState.taskAction === "DIRECT_ACTION" || activeState.isDirectAction === true;
    if (isDirectAction) {
      activeState.toolMix.direct_action_tool_calls = (activeState.toolMix.direct_action_tool_calls || 0) + 1;
      activeState.direct_action_tool_calls = (activeState.direct_action_tool_calls || 0) + 1;
      if (activeState.directActionType === "GIT_COMMIT_PUSH") {
        activeState.toolMix.git_commit_push_tool_calls = (activeState.toolMix.git_commit_push_tool_calls || 0) + 1;
      }
    }

    const nativeTools = ["view_file", "grep_search", "find_by_name", "replace_file_content", "write_to_file", "list_dir", "ask_question"];
    if (nativeTools.includes(toolName)) {
      activeState.native_tool_calls = (activeState.native_tool_calls || 0) + 1;
    }

    if (toolName === "view_file") {
      activeState.read_tool_calls = (activeState.read_tool_calls || 0) + 1;
      activeState.toolMix.native_read_calls = (activeState.toolMix.native_read_calls || 0) + 1;
      activeState.consecutiveFileReads = (activeState.consecutiveFileReads || 0) + 1;
      const hasWindow = toolArgs.StartLine !== undefined || toolArgs.EndLine !== undefined;
      if (hasWindow) {
        activeState.toolMix.targeted_view_calls = (activeState.toolMix.targeted_view_calls || 0) + 1;
        const start = toolArgs.StartLine || 1;
        const end = toolArgs.EndLine || (start + 80);
        const lines = Math.max(1, end - start + 1);
        activeState.toolMix.view_file_lines = (activeState.toolMix.view_file_lines || 0) + lines;
      } else {
        activeState.toolMix.full_file_view_calls = (activeState.toolMix.full_file_view_calls || 0) + 1;
        activeState.toolMix.view_file_lines = (activeState.toolMix.view_file_lines || 0) + 100;
      }
    } else if (toolName === "grep_search") {
      activeState.read_tool_calls = (activeState.read_tool_calls || 0) + 1;
      activeState.toolMix.native_search_calls = (activeState.toolMix.native_search_calls || 0) + 1;
      activeState.consecutiveFileReads = 0;
    } else if (toolName === "find_by_name") {
      activeState.read_tool_calls = (activeState.read_tool_calls || 0) + 1;
      activeState.toolMix.native_find_calls = (activeState.toolMix.native_find_calls || 0) + 1;
      activeState.consecutiveFileReads = 0;
    } else if (toolName === "list_dir") {
      activeState.read_tool_calls = (activeState.read_tool_calls || 0) + 1;
      activeState.consecutiveFileReads = 0;
    } else if (toolName === "replace_file_content" || toolName === "write_to_file") {
      activeState.write_tool_calls = (activeState.write_tool_calls || 0) + 1;
      activeState.toolMix.native_edit_calls = (activeState.toolMix.native_edit_calls || 0) + 1;
      activeState.consecutiveFileReads = 0;
      const target = toolArgs.TargetFile || toolArgs.targetFile || toolArgs.path || null;
      if (target) {
        recordMutation(activeState, {
          paths: [target],
          type: toolName === "write_to_file" ? "CREATE" : "EDIT",
        });
      }
    } else if (toolName === "run_command") {
      activeState.run_command_calls = (activeState.run_command_calls || 0) + 1;
      activeState.consecutiveFileReads = 0;
      activeState.toolMix.shell_calls = (activeState.toolMix.shell_calls || 0) + 1;
      const rawCmd = (executionRecord && executionRecord.command) || toolArgs.CommandLine || toolArgs.command || toolArgs.cmd || "";
      shellClassification = classifyShellIntent(rawCmd);

      // Track git inspections
      trackGitInspection(activeState, rawCmd);

      // Track git transactions
      if (rawCmd.includes("git-operation.mjs")) {
        activeState.toolMix.git_transactions = (activeState.toolMix.git_transactions || 0) + 1;
        if (executionRecord) {
          if (executionRecord.exitCode === 0) {
            activeState.toolMix.git_transaction_success = (activeState.toolMix.git_transaction_success || 0) + 1;
          } else {
            activeState.toolMix.git_transaction_partial_failure = (activeState.toolMix.git_transaction_partial_failure || 0) + 1;
          }
        }
      }

      // Track shell mutations
      shellMutation = classifyShellMutation(rawCmd);
      if (shellMutation.isMutation) {
        activeState.toolMix.shell_mutations = (activeState.toolMix.shell_mutations || 0) + 1;
        if (shellMutation.unknownScope) {
          activeState.toolMix.shell_unknown_mutations = (activeState.toolMix.shell_unknown_mutations || 0) + 1;
        }
        recordMutation(activeState, {
          paths: shellMutation.targetPath ? [shellMutation.targetPath] : [],
          type: "SHELL_MUTATION",
          scope: shellMutation.scope,
          unknownScope: shellMutation.unknownScope,
          command: rawCmd,
        });
      }

      switch (shellClassification.category) {
        case "SHELL_READ":
          activeState.read_tool_calls = (activeState.read_tool_calls || 0) + 1;
          activeState.toolMix.shell_read_calls = (activeState.toolMix.shell_read_calls || 0) + 1;
          break;
        case "SHELL_SEARCH":
          activeState.read_tool_calls = (activeState.read_tool_calls || 0) + 1;
          activeState.toolMix.shell_search_calls = (activeState.toolMix.shell_search_calls || 0) + 1;
          break;
        case "SHELL_DISCOVERY":
          activeState.read_tool_calls = (activeState.read_tool_calls || 0) + 1;
          activeState.toolMix.shell_discovery_calls = (activeState.toolMix.shell_discovery_calls || 0) + 1;
          break;
        case "SHELL_EDIT":
          activeState.write_tool_calls = (activeState.write_tool_calls || 0) + 1;
          activeState.toolMix.shell_edit_calls = (activeState.toolMix.shell_edit_calls || 0) + 1;
          break;
        case "SHELL_VALIDATION":
          activeState.verification_tool_calls = (activeState.verification_tool_calls || 0) + 1;
          activeState.toolMix.shell_validation_calls = (activeState.toolMix.shell_validation_calls || 0) + 1;
          break;
        case "SHELL_TEST":
          activeState.verification_tool_calls = (activeState.verification_tool_calls || 0) + 1;
          activeState.toolMix.shell_test_calls = (activeState.toolMix.shell_test_calls || 0) + 1;
          break;
        case "SHELL_BUILD":
          activeState.verification_tool_calls = (activeState.verification_tool_calls || 0) + 1;
          activeState.toolMix.shell_build_calls = (activeState.toolMix.shell_build_calls || 0) + 1;
          break;
        case "SHELL_HEAVY_EXECUTION":
          activeState.toolMix.shell_heavy_calls = (activeState.toolMix.shell_heavy_calls || 0) + 1;
          break;
        default:
          if (/^(?:npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|node\s+--test|pytest|cargo\s+test|vitest|jest)\b/.test(rawCmd.trim())) {
            activeState.verification_tool_calls = (activeState.verification_tool_calls || 0) + 1;
          }
          break;
      }

      if (shellClassification.avoidable) {
        activeState.toolMix.avoidable_shell_calls = (activeState.toolMix.avoidable_shell_calls || 0) + 1;
      }

      if (payload.fallbackReason || rawCmd.includes("--fallback") || payload.isFallback === true) {
        recordNativeToolFallback(activeState, {
          reason: payload.fallbackReason || "native_tool_failed",
          shellCommand: rawCmd,
        });
      }
    } else if (toolName === "invoke_subagent") {
      activeState.invoke_subagent_calls = (activeState.invoke_subagent_calls || 0) + 1;
      activeState.subagent_invocations = (activeState.subagent_invocations || 0) + 1;
      const subagents = Array.isArray(toolArgs.Subagents) ? toolArgs.Subagents : [];
      for (const sub of subagents) {
        const role = String(sub.Role || sub.TypeName || "").toLowerCase();
        const msg = sub.Prompt || "";
        const pBytes = Buffer.byteLength(String(msg), "utf-8");
        activeState.toolMix.worker_packet_chars = (activeState.toolMix.worker_packet_chars || 0) + msg.length;
        activeState.toolMix.worker_packet_bytes = (activeState.toolMix.worker_packet_bytes || 0) + pBytes;

        if (role.includes("reviewer") || sub.TypeName === "flash-reviewer") {
          activeState.reviewer_invocations = (activeState.reviewer_invocations || 0) + 1;
          activeState.review_packet_bytes = (activeState.review_packet_bytes || 0) + pBytes;
        } else {
          activeState.worker_invocations = (activeState.worker_invocations || 0) + 1;
          activeState.worker_packet_bytes = (activeState.worker_packet_bytes || 0) + pBytes;
        }
      }
    } else if (toolName === "manage_subagents") {
      activeState.manage_subagents_calls = (activeState.manage_subagents_calls || 0) + 1;
      if (payload.result) {
        activeState.worker_completion_events = (activeState.worker_completion_events || 0) + 1;
        const compBytes = Buffer.byteLength(JSON.stringify(payload.result), "utf-8");
        activeState.worker_completion_packet_bytes = (activeState.worker_completion_packet_bytes || 0) + compBytes;
      }
    } else if (toolName === "send_message") {
      activeState.send_message_calls = (activeState.send_message_calls || 0) + 1;
      const msg = toolArgs.Message || "";
      if (msg) {
        const pBytes = Buffer.byteLength(String(msg), "utf-8");
        activeState.toolMix.worker_packet_chars = (activeState.toolMix.worker_packet_chars || 0) + msg.length;
        activeState.toolMix.worker_packet_bytes = (activeState.toolMix.worker_packet_bytes || 0) + pBytes;
        activeState.worker_packet_bytes = (activeState.worker_packet_bytes || 0) + pBytes;
      }
    }

    // Sequence mutation tracking: before first mutation vs after last mutation
    const isMutationStep = toolName === "write_to_file"
      || toolName === "replace_file_content"
      || (shellMutation && shellMutation.isMutation);

    if (!activeState.first_mutation_occurred) {
      if (isMutationStep) {
        activeState.first_mutation_occurred = true;
        activeState.tools_after_last_mutation = 0;
      } else {
        activeState.tools_before_first_mutation = (activeState.tools_before_first_mutation || 0) + 1;
      }
    } else {
      if (isMutationStep) {
        activeState.tools_after_last_mutation = 0;
      } else {
        activeState.tools_after_last_mutation = (activeState.tools_after_last_mutation || 0) + 1;
      }
    }

    // 3. Process execution record idempotently
    if (executionRecord && executionRecord.command) {
      const isAlreadyConsumed = executionRecord.consumed === true;
      if (!Array.isArray(activeState.evidenceLedger)) {
        activeState.evidenceLedger = [];
      }

      const alreadyInLedger = activeState.evidenceLedger.some(
        (e) => e && e.executionId === executionRecord.executionId
      );

      if (!isAlreadyConsumed && !alreadyInLedger) {
        recordedEvidence = classifyExecutionEvidence(
          executionRecord.command,
          executionRecord.exitCode,
          executionRecord.preview,
          executionRecord.durationMs,
          executionRecord.artifactPath,
          executionRecord.executionId,
          activeState.mutationSeq || 0
        );

        const existingIdx = activeState.evidenceLedger.findIndex(
          (e) => e && e.command === recordedEvidence.command && e.type === recordedEvidence.type && e.scope === recordedEvidence.scope
        );
        if (existingIdx >= 0) {
          activeState.evidenceLedger[existingIdx] = recordedEvidence;
        } else {
          activeState.evidenceLedger.push(recordedEvidence);
        }

        const bytes = executionRecord.totalBytes || 0;
        activeState.totalToolOutputBytes = (activeState.totalToolOutputBytes || 0) + bytes;
        if (executionRecord.truncated) {
          activeState.truncatedToolOutputBytes = (activeState.truncatedToolOutputBytes || 0) + bytes;
          activeState.artifactOutputBytes = (activeState.artifactOutputBytes || 0) + bytes;
        } else {
          activeState.inlineToolOutputBytes = (activeState.inlineToolOutputBytes || 0) + bytes;
        }

        executionRecord.consumed = true;
        executionRecord.consumedAt = new Date().toISOString();
        try {
          const execFilePath = resolve(executionsDir, `${executionRecord.executionId}.json`);
          writeFileSync(execFilePath, JSON.stringify(executionRecord, null, 2), "utf-8");
        } catch {}
      }
    }

    // Update health diagnostics
    const overuse = detectShellOveruse(activeState.toolMix);
    activeState.shellOveruseDetected = overuse.overuseDetected;
    if (overuse.overuseDetected) {
      activeState.shellOveruseReason = overuse.reason;
    } else {
      delete activeState.shellOveruseReason;
    }

    const exploration = detectExplorationOverhead(activeState);
    activeState.explorationOverheadDetected = exploration.overheadDetected;
    if (exploration.overheadDetected) {
      activeState.explorationOverheadReason = exploration.reason;
    } else {
      delete activeState.explorationOverheadReason;
    }

    if (isDirectAction) {
      const directOverhead = detectDirectActionOverhead(activeState.toolMix);
      activeState.directActionOverheadDetected = directOverhead.overheadDetected;
      if (directOverhead.overheadDetected) {
        activeState.directActionOverheadReason = directOverhead.reason;
      } else {
        delete activeState.directActionOverheadReason;
      }
    }

    if (activeState.retriesUsed !== undefined) {
      activeState.retry_count = activeState.retriesUsed;
    }
    if (activeState.toolMix?.verification_batches) {
      activeState.verification_batches = activeState.toolMix.verification_batches;
    }

    try {
      writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
    } catch {}

    // Clean up expired pending files older than 1 hour
    try {
      if (existsSync(pendingExecutionsDir)) {
        const pendingEntries = readdirSync(pendingExecutionsDir);
        const now = Date.now();
        for (const f of pendingEntries) {
          if (f.endsWith(".json")) {
            const pPath = resolve(pendingExecutionsDir, f);
            try {
              const st = statSync(pPath);
              if (now - st.mtimeMs > 3600000) unlinkSync(pPath);
            } catch {}
          }
        }
      }
    } catch {}

    const rawModelName = payload.modelName ?? payload.model ?? null;
    const isObservable = Boolean(rawModelName && rawModelName !== "auto");
    const actualRuntimeModel = isObservable ? rawModelName : null;

    const requestedAgent = payload.requested_agent
      ?? payload.requestedAgent
      ?? activeState.requested_agent
      ?? activeState.requestedAgent
      ?? (activeState.activeRole === "FLASH" || activeState.activeRole === "WORKER" ? "flash-worker"
        : (activeState.activeRole === "ORCHESTRATOR" || activeState.activeRole === "FLASH_ORCHESTRATOR" || activeState.activeRole === "SONNET" ? "flash-orchestrator"
        : (activeState.activeRole === "REVIEWER" || activeState.activeRole === "FLASH_REVIEWER" || activeState.activeRole === "OPUS" ? "flash-reviewer" : null)));

    const requestedTier = payload.requested_tier
      ?? payload.requestedTier
      ?? activeState.requested_tier
      ?? activeState.requestedTier
      ?? (activeState.activeRole === "FLASH" || activeState.activeRole === "WORKER" ? "flash" : null);

    const configuredModel = payload.configured_model
      ?? payload.configuredModel
      ?? activeState.configured_model
      ?? activeState.configuredModel
      ?? (activeState.activeRole === "FLASH" || activeState.activeRole === "WORKER" ? "gemini-3.8-flash-high"
        : (activeState.activeRole === "ORCHESTRATOR" || activeState.activeRole === "FLASH_ORCHESTRATOR" || activeState.activeRole === "SONNET" ? "gemini-3.8-flash-medium"
        : (activeState.activeRole === "REVIEWER" || activeState.activeRole === "FLASH_REVIEWER" || activeState.activeRole === "OPUS" ? "gemini-3.8-flash-high" : null)));

    const event = {
      timestamp: new Date().toISOString(),
      stepIdx: payload.stepIdx ?? null,
      error: payload.error ?? null,
      conversationId: payload.conversationId ?? null,
      toolName: payload.toolName ?? payload.toolCall?.name ?? null,
      modelName: payload.modelName ?? null,
      requested_agent: requestedAgent,
      requested_tier: requestedTier,
      configured_model: configuredModel,
      actual_runtime_model: actualRuntimeModel,
      runtime_model_observable: isObservable,
      tool_output_bytes: executionRecord ? (executionRecord.totalBytes || 0) : null,
      inline_tool_output_bytes: executionRecord ? (executionRecord.truncated ? 0 : (executionRecord.totalBytes || 0)) : null,
      truncated_tool_output_bytes: executionRecord ? (executionRecord.truncated ? (executionRecord.totalBytes || 0) : 0) : null,
      artifact_output_bytes: executionRecord && executionRecord.artifactPath ? (executionRecord.totalBytes || 0) : null,
      evidence_recorded: recordedEvidence ? recordedEvidence.type : null,
      execution_id: resolvedExecutionId,
      shell_intent: shellClassification ? shellClassification.category : null,
      avoidable_shell: shellClassification ? shellClassification.avoidable : null,
      mutation_seq: activeState.mutationSeq || 0,
      tool_mix: activeState.toolMix || null,
      benchmarkRunId: activeState.benchmarkRunId || null,
      taskId: activeState.taskId || null,
      tool_calls_total: activeState.tool_calls_total || 0,
      native_tool_calls: activeState.native_tool_calls || 0,
      run_command_calls: activeState.run_command_calls || 0,
      read_tool_calls: activeState.read_tool_calls || 0,
      write_tool_calls: activeState.write_tool_calls || 0,
      verification_tool_calls: activeState.verification_tool_calls || 0,
      tools_before_first_mutation: activeState.tools_before_first_mutation || 0,
      tools_after_last_mutation: activeState.tools_after_last_mutation || 0,
      invoke_subagent_calls: activeState.invoke_subagent_calls || 0,
      subagent_invocations: activeState.subagent_invocations || 0,
      worker_invocations: activeState.worker_invocations || 0,
      reviewer_invocations: activeState.reviewer_invocations || 0,
      manage_subagents_calls: activeState.manage_subagents_calls || 0,
      send_message_calls: activeState.send_message_calls || 0,
      worker_packet_bytes: activeState.worker_packet_bytes || 0,
      worker_completion_packet_bytes: activeState.worker_completion_packet_bytes || 0,
      review_packet_bytes: activeState.review_packet_bytes || 0,
      context_proxy_bytes: activeState.context_proxy_bytes || 0,
      type: "TOOL_STEP"
    };

    appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
  } catch {}

  console.log(JSON.stringify({}));
}

main();
