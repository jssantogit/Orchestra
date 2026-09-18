import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
  isControlPlanePath,
  verifyWorkerValidation,
  verifyTaskEvidence,
  isWorkerRole,
} from "../skills/agy-orchestra/routing-policy.mjs";
import { recordDecisionOutcome, getPendingDecision } from "../dream/outcome-recorder.mjs";
import { dreamCorrelationKey } from "../dream/decision-recorder.mjs";
import {
  factualSubagentMatchesPending,
  filterFactualPendingCandidates,
  findFactualSubagentRecord,
  isSymmetricReviewerSet,
} from "./child-identity.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function normalizePath(p) {
  return String(p || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
}

function saveRoleBindings(roleBindingsPath, data) {
  try {
    mkdirSync(dirname(roleBindingsPath), { recursive: true });
    writeFileSync(roleBindingsPath, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
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
    executionsDir: resolve(repoRoot, ".agents/state/executions"),
    pendingExecutionsDir: resolve(repoRoot, ".agents/state/executions/pending"),
  };
}

function readGovernanceObject(path, label) {
  if (!path || !existsSync(path)) return { ok: true, exists: false, value: null };
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

function loadRoleBindings(roleBindingsPath) {
  const loaded = readGovernanceObject(roleBindingsPath, "ROLE_BINDINGS");
  if (!loaded.ok) {
    return {
      mainConversationId: null,
      bindings: {},
      pendingSubagents: [],
      __governanceLoadError: loaded.reason,
    };
  }
  if (!loaded.exists) return { mainConversationId: null, bindings: {}, pendingSubagents: [] };
  if (!validRoleBindingsShape(loaded.value)) {
    return {
      mainConversationId: null,
      bindings: {},
      pendingSubagents: [],
      __governanceLoadError: "ROLE_BINDINGS_INVALID_SHAPE",
    };
  }
  return loaded.value;
}

function resolveActorIdentity(payload = {}, activeState = {}, roleBindings = {}, repoRoot = "", roleBindingsPath = "") {
  const convId = payload.conversationId || null;

  if (convId) {
    const existing = (roleBindings.bindings && roleBindings.bindings[convId])
      || (roleBindings.conversations && roleBindings.conversations[convId]);

    if (existing) {
      if (existing.source !== "RUNTIME_IDENTITY") {
        const parentConversationId = existing.parentConversationId
          || roleBindings.mainConversationId
          || payload.parentConversationId
          || activeState.parentConversationId
          || null;
        const factualRecord = findFactualSubagentRecord({
          parentConversationId,
          childConversationId: convId,
        });
        const pending = Array.isArray(roleBindings.pendingSubagents)
          ? roleBindings.pendingSubagents.find((p) => p.seq === existing.pendingSeq)
          : null;
        if (factualRecord && pending && factualSubagentMatchesPending(factualRecord, pending)) {
          existing.confidence = "HIGH";
          existing.source = "RUNTIME_IDENTITY";
          existing.factualIdentityAt = new Date().toISOString();
          if (roleBindings.bindings) roleBindings.bindings[convId] = existing;
          if (roleBindings.conversations) roleBindings.conversations[convId] = existing;
          if (roleBindingsPath) saveRoleBindings(roleBindingsPath, roleBindings);
        }
      }

      return {
        role: existing.role,
        source: existing.source || "CONVERSATION_BOUND_IDENTITY",
        confidence: existing.confidence || (existing.source === "RUNTIME_IDENTITY" ? "HIGH" : "MEDIUM"),
        actorId: convId,
        agentProfile: existing.profile || null,
        model: existing.model || payload.modelName || null,
        delegationKind: existing.delegationKind || null,
        attempt: Number.isInteger(existing.attempt) ? existing.attempt : 0,
      };
    }

    if (roleBindings.mainConversationId && convId === roleBindings.mainConversationId) {
      return {
        role: "ORCHESTRATOR",
        source: "CONVERSATION_BOUND_IDENTITY",
        confidence: "HIGH",
        actorId: convId,
        agentProfile: "flash-orchestrator",
        model: payload.modelName || "gemini-3.8-flash-medium",
      };
    }

    if ((roleBindings.mainConversationId && convId !== roleBindings.mainConversationId)
      || (Array.isArray(roleBindings.pendingSubagents) && roleBindings.pendingSubagents.length > 0)) {
      const pendingList = Array.isArray(roleBindings.pendingSubagents) ? roleBindings.pendingSubagents : [];
      const unconsumed = pendingList.filter((p) => !p.consumed);

      if (unconsumed.length > 0) {
        const parentConversationId = payload.parentConversationId
          || roleBindings.mainConversationId
          || activeState.parentConversationId
          || null;
        const activeTaskId = payload.taskId || payload.taskIdentifier || activeState.taskId || activeState.taskKey || process.env.BENCHMARK_TASK_ID || null;
        const activeRunId = payload.benchmarkRunId || activeState.benchmarkRunId || process.env.BENCHMARK_RUN_ID || null;

        let matched = null;
        let source = "UNRESOLVED";
        let confidence = "LOW";
        let slotAssignment = null;

        const factualRecord = findFactualSubagentRecord({
          parentConversationId,
          childConversationId: convId,
        });
        if (factualRecord) {
          const factualCandidates = filterFactualPendingCandidates({
            pendingSubagents: pendingList,
            record: factualRecord,
            parentConversationId,
            taskId: activeTaskId,
            benchmarkRunId: activeRunId,
            attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
          });
          if (factualCandidates.length === 1) {
            matched = factualCandidates[0];
          } else if (isSymmetricReviewerSet(factualCandidates)) {
            matched = factualCandidates.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0];
            slotAssignment = "SYMMETRIC_REVIEW_SLOT";
          }
          if (matched) {
            source = "RUNTIME_IDENTITY";
            confidence = "HIGH";
          }
        }

        if (!matched) {
          const reqRole = (payload.agentRole || payload.role || "").toUpperCase();
          const reqProfile = payload.agentProfile || payload.typeName || payload.profile || "";
          const reqModel = payload.modelName || "";
          const hasRuntimeDiscriminator = Boolean(reqRole || reqProfile);

          if (hasRuntimeDiscriminator) {
            let candidates = unconsumed;
            if (parentConversationId) {
              candidates = candidates.filter((p) => p.parentConversationId === parentConversationId);
            }
            if (activeTaskId) {
              candidates = candidates.filter((p) => (p.taskIdentifier || p.taskId) === activeTaskId);
            }
            if (activeRunId) {
              candidates = candidates.filter((p) => p.benchmarkRunId === activeRunId);
            }
            if (reqRole) {
              candidates = candidates.filter((p) => p.role && p.role.toUpperCase() === reqRole);
            }
            if (reqProfile) {
              candidates = candidates.filter((p) => p.profile === reqProfile || p.typeName === reqProfile);
            }
            if (reqModel) {
              candidates = candidates.filter((p) => p.model === reqModel || (p.model && reqModel.includes(p.model)));
            }

            if (candidates.length === 1) {
              matched = candidates[0];
            } else if (isSymmetricReviewerSet(candidates)) {
              matched = candidates.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0];
              slotAssignment = "SYMMETRIC_REVIEW_SLOT";
            }

            if (matched) {
              source = "HOOK_PAYLOAD_CORRELATION";
              confidence = "MEDIUM";
            }
          }
        }

        if (matched && source === "HOOK_PAYLOAD_CORRELATION") {
          // Hook payload is useful for applying a conservative role policy, but is
          // not durable child identity. Do not consume/reserve the pending slot.
          return {
            role: matched.role || "UNKNOWN",
            source,
            confidence,
            actorId: convId,
            agentProfile: matched.profile || matched.typeName || null,
            model: matched.model || payload.modelName || null,
            delegationKind: matched.delegationKind || null,
            attempt: Number.isInteger(matched.attempt) ? matched.attempt : 0,
          };
        }

        if (matched) {
          const consumedAt = new Date().toISOString();
          matched.consumed = true;
          matched.consumedBy = convId;
          matched.consumedAt = consumedAt;

          const childRole = matched.role || null;
          const childProfile = matched.profile || matched.typeName || null;
          const childModel = matched.model || payload.modelName || (childRole === "REVIEWER" ? "gemini-3.8-flash-high" : null);

          if (!roleBindings.bindings) roleBindings.bindings = {};
          if (!roleBindings.conversations) roleBindings.conversations = {};
          const record = {
            conversationId: convId,
            role: childRole || "UNKNOWN",
            profile: childProfile || null,
            model: childModel,
            parentConversationId: matched.parentConversationId || roleBindings.mainConversationId || null,
            taskIdentifier: matched.taskIdentifier || activeTaskId || null,
            benchmarkRunId: matched.benchmarkRunId || activeRunId || null,
            attempt: Number.isInteger(matched.attempt) ? matched.attempt : 0,
            originToolCallId: matched.originToolCallId || matched.toolCallId || null,
            originStepIdx: matched.originStepIdx ?? null,
            pendingSeq: matched.seq ?? null,
            delegationKind: matched.delegationKind || null,
            decisionCorrelationKey: matched.decisionCorrelationKey || null,
            decisionType: matched.decisionType || null,
            decisionBranchOrdinal: matched.decisionBranchOrdinal ?? null,
            confidence,
            source,
            slotAssignment,
            factualIdentityAt: new Date().toISOString(),
            consumed: true,
            consumedBy: convId,
            consumedAt,
          };
          roleBindings.bindings[convId] = record;
          roleBindings.conversations[convId] = record;
          if (roleBindingsPath) saveRoleBindings(roleBindingsPath, roleBindings);

          return {
            role: childRole || "UNKNOWN",
            source,
            confidence,
            actorId: convId,
            agentProfile: childProfile,
            model: childModel,
            delegationKind: matched.delegationKind || null,
            attempt: Number.isInteger(matched.attempt) ? matched.attempt : 0,
          };
        }
      }
    }
  }

  const stateRole = String(activeState.activeRole || activeState.role || "").toUpperCase();
  if (stateRole) {
    if (stateRole === "REVIEWER" || stateRole === "FLASH_REVIEWER") {
      return {
        role: "REVIEWER",
        source: "STATE_DERIVED",
        confidence: "MEDIUM",
        actorId: convId,
        agentProfile: "flash-reviewer",
        model: payload.modelName || "gemini-3.8-flash-high",
      };
    }
    if (stateRole === "ORCHESTRATOR" || stateRole === "FLASH_ORCHESTRATOR") {
      const expectedMainConversationId = roleBindings.mainConversationId || activeState.conversationId || null;
      if (expectedMainConversationId && convId && convId !== expectedMainConversationId) {
        return {
          role: "UNKNOWN",
          source: "UNRESOLVED",
          confidence: "LOW",
          actorId: convId,
        };
      }
      return {
        role: "ORCHESTRATOR",
        source: expectedMainConversationId && convId === expectedMainConversationId
          ? "CONVERSATION_BOUND_IDENTITY"
          : "STATE_DERIVED",
        confidence: expectedMainConversationId && convId === expectedMainConversationId ? "HIGH" : "MEDIUM",
        actorId: convId,
        agentProfile: "flash-orchestrator",
        model: payload.modelName || "gemini-3.8-flash-medium",
      };
    }
    if (stateRole === "WORKER" || stateRole === "FLASH" || stateRole === "FLASH_WORKER") {
      return {
        role: "WORKER",
        source: "STATE_DERIVED",
        confidence: "MEDIUM",
        actorId: convId,
        agentProfile: activeState.requested_agent || "flash-worker",
        model: payload.modelName || "gemini-3.8-flash",
      };
    }
  }

  if (convId && !roleBindings.mainConversationId && (!Array.isArray(roleBindings.pendingSubagents) || roleBindings.pendingSubagents.length === 0)) {
    if (stateRole === "ORCHESTRATOR" || stateRole === "FLASH_ORCHESTRATOR") {
      roleBindings.mainConversationId = convId;
      if (!roleBindings.bindings) roleBindings.bindings = {};
      if (!roleBindings.conversations) roleBindings.conversations = {};
      const orchRecord = {
        role: "ORCHESTRATOR",
        profile: "flash-orchestrator",
        model: payload.modelName || "gemini-3.8-flash-medium",
        source: "CONVERSATION_BOUND_IDENTITY",
        confidence: "HIGH",
      };
      roleBindings.bindings[convId] = orchRecord;
      roleBindings.conversations[convId] = orchRecord;
      if (roleBindingsPath) saveRoleBindings(roleBindingsPath, roleBindings);
      return {
        role: "ORCHESTRATOR",
        source: "CONVERSATION_BOUND_IDENTITY",
        confidence: "HIGH",
        actorId: convId,
        agentProfile: "flash-orchestrator",
        model: payload.modelName || "gemini-3.8-flash-medium",
      };
    }
  }

  return {
    role: "UNKNOWN",
    source: "UNRESOLVED",
    confidence: "LOW",
    actorId: convId,
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
    const { repoRoot, statePath, roleBindingsPath, telemetryPath, executionsDir, pendingExecutionsDir } = getWorkspacePaths(payload);
    mkdirSync(dirname(telemetryPath), { recursive: true });

    let activeState = {};
    const stateLoad = readGovernanceObject(statePath, "ACTIVE_STATE");
    if (!stateLoad.ok) {
      try {
        appendFileSync(telemetryPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "GOVERNANCE_STATE_CORRUPT",
          phase: "POST_TOOL",
          reason: stateLoad.reason,
          conversationId: payload.conversationId || null,
          toolName: payload.toolName ?? payload.toolCall?.name ?? null,
        }) + "\n", "utf-8");
      } catch {}
      console.log(JSON.stringify({}));
      return;
    }
    if (stateLoad.exists) activeState = stateLoad.value;

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
    const roleBindings = loadRoleBindings(roleBindingsPath);
    if (roleBindings.__governanceLoadError) {
      try {
        appendFileSync(telemetryPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "GOVERNANCE_STATE_CORRUPT",
          phase: "POST_TOOL",
          reason: roleBindings.__governanceLoadError,
          conversationId: payload.conversationId || null,
          toolName: payload.toolName ?? payload.toolCall?.name ?? null,
        }) + "\n", "utf-8");
      } catch {}
      console.log(JSON.stringify({}));
      return;
    }
    const actor = resolveActorIdentity(payload, activeState, roleBindings, repoRoot);

    const toolName = payload.toolName ?? payload.toolCall?.name ?? null;
    const toolArgs = payload.toolCall?.args || payload.toolArgs || {};
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

    const nativeTools = ["view_file", "grep_search", "find_by_name", "replace_file_content", "write_to_file", "edit_file", "create_file", "list_dir", "ask_question"];
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
    } else if (["replace_file_content", "write_to_file", "edit_file", "create_file"].includes(toolName)) {
      activeState.write_tool_calls = (activeState.write_tool_calls || 0) + 1;
      activeState.toolMix.native_edit_calls = (activeState.toolMix.native_edit_calls || 0) + 1;
      activeState.consecutiveFileReads = 0;
      const rawTarget = toolArgs.TargetFile || toolArgs.targetFile || toolArgs.FilePath || toolArgs.filePath || toolArgs.path || null;
      if (rawTarget) {
        const relTarget = normalizePath(rawTarget.startsWith(repoRoot) ? relative(repoRoot, rawTarget) : rawTarget);
        const isCP = isControlPlanePath(relTarget);
        if (isCP) {
          activeState.controlPlaneWrites = (activeState.controlPlaneWrites || 0) + 1;
        } else {
          if (actor.role === "ORCHESTRATOR" || actor.role === "FLASH_ORCHESTRATOR") {
            activeState.orchestratorWorkspaceWrites = (activeState.orchestratorWorkspaceWrites || 0) + 1;
          } else if (!actor.role || actor.role === "UNKNOWN") {
            activeState.unknownWorkspaceWrites = (activeState.unknownWorkspaceWrites || 0) + 1;
          } else if (actor.role === "WORKER" || actor.role === "FLASH" || actor.role === "FLASH_WORKER" || actor.role === "FLASH_LOW_WORKER" || actor.role === "FLASH_MEDIUM_WORKER") {
            activeState.workerWorkspaceWrites = (activeState.workerWorkspaceWrites || 0) + 1;
          }
        }
        recordMutation(activeState, {
          paths: [relTarget],
          type: (toolName === "write_to_file" || toolName === "create_file") ? "CREATE" : "EDIT",
          tool: toolName,
          actorRole: actor.role,
          actorId: actor.actorId || conversationId || null,
          conversationId: actor.actorId || conversationId || null,
          agentProfile: actor.agentProfile || null,
          model: actor.model || null,
          confidence: actor.confidence || "LOW",
          evidenceSource: actor.source || "STATE_DERIVED",
          isControlPlane: isCP,
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
        const rawTarget = shellMutation.targetPath || null;
        const relTarget = rawTarget ? normalizePath(rawTarget.startsWith(repoRoot) ? relative(repoRoot, rawTarget) : rawTarget) : null;
        const isCP = relTarget ? isControlPlanePath(relTarget) : false;
        if (isCP) {
          activeState.controlPlaneWrites = (activeState.controlPlaneWrites || 0) + 1;
        } else {
          if (actor.role === "ORCHESTRATOR" || actor.role === "FLASH_ORCHESTRATOR") {
            activeState.orchestratorWorkspaceWrites = (activeState.orchestratorWorkspaceWrites || 0) + 1;
          } else if (!actor.role || actor.role === "UNKNOWN") {
            activeState.unknownWorkspaceWrites = (activeState.unknownWorkspaceWrites || 0) + 1;
          } else if (actor.role === "WORKER" || actor.role === "FLASH" || actor.role === "FLASH_WORKER" || actor.role === "FLASH_LOW_WORKER" || actor.role === "FLASH_MEDIUM_WORKER") {
            activeState.workerWorkspaceWrites = (activeState.workerWorkspaceWrites || 0) + 1;
          }
        }
        recordMutation(activeState, {
          paths: relTarget ? [relTarget] : [],
          type: "SHELL_MUTATION",
          tool: "run_command",
          scope: shellMutation.scope,
          unknownScope: shellMutation.unknownScope,
          command: rawCmd,
          actorRole: actor.role,
          actorId: actor.actorId || conversationId || null,
          conversationId: actor.actorId || conversationId || null,
          agentProfile: actor.agentProfile || null,
          model: actor.model || null,
          confidence: actor.confidence || "LOW",
          evidenceSource: actor.source || "STATE_DERIVED",
          isControlPlane: isCP,
        });
      }

      const isWorker = actor.role === "WORKER" || actor.role === "FLASH" || actor.role === "FLASH_WORKER" || actor.role === "FLASH_LOW_WORKER" || actor.role === "FLASH_MEDIUM_WORKER";
      const isValidation = shellClassification.category === "SHELL_VALIDATION"
        || shellClassification.category === "SHELL_TEST"
        || /^(?:npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|node\s+--test|pytest|cargo\s+test|vitest|jest)\b/.test(rawCmd.trim());

      const exitCode = executionRecord && typeof executionRecord.exitCode === "number"
        ? executionRecord.exitCode
        : (typeof payload.exitCode === "number" ? payload.exitCode : (typeof payload.toolResult?.exitCode === "number" ? payload.toolResult.exitCode : null));

      if (isValidation) {
        if (isWorker) {
          activeState.workerValidationObserved = true;
          activeState.workerValidationCommand = rawCmd;
          activeState.workerValidationActor = actor.role;
          activeState.workerValidationActorConfidence = actor.confidence || "LOW";
          activeState.workerValidationExecutionId = resolvedExecutionId || executionRecord?.executionId || null;
          activeState.workerValidationExitCode = exitCode;
          activeState.workerValidationMutationSeq = activeState.mutationSeq || 0;
        } else if (actor.role === "ORCHESTRATOR" || actor.role === "FLASH_ORCHESTRATOR") {
          activeState.orchestratorValidationObserved = true;
          activeState.orchestratorValidationCommand = rawCmd;
          activeState.orchestratorValidationExitCode = exitCode;
        } else if (actor.role === "UNKNOWN" || !actor.role) {
          activeState.unknownValidationObserved = true;
          activeState.unknownValidationCommand = rawCmd;
          activeState.unknownValidationExitCode = exitCode;
        }

        if (!executionRecord && typeof exitCode === "number") {
          if (!Array.isArray(activeState.evidenceLedger)) {
            activeState.evidenceLedger = [];
          }
          const ev = {
            executionId: resolvedExecutionId || null,
            command: rawCmd,
            exitCode,
            mutationSeq: activeState.mutationSeq || 0,
            actorRole: actor.role,
            actorId: actor.actorId || conversationId || null,
            conversationId: conversationId || null,
            confidence: actor.confidence || "MEDIUM",
            evidenceSource: actor.source || "TOOL_RESULT",
            timestamp: new Date().toISOString(),
          };
          const existingIdx = activeState.evidenceLedger.findIndex(
            (e) => e && resolvedExecutionId && e.executionId === resolvedExecutionId
          );
          if (existingIdx >= 0) {
            activeState.evidenceLedger[existingIdx] = ev;
          } else {
            activeState.evidenceLedger.push(ev);
          }
        }
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
      let subagents = Array.isArray(toolArgs.Subagents) ? toolArgs.Subagents : [];
      if (subagents.length === 0 && typeof toolArgs.Subagents === "string") {
        try {
          const parsed = JSON.parse(toolArgs.Subagents);
          if (Array.isArray(parsed)) subagents = parsed;
        } catch {}
      }
      activeState.subagent_invocations = (activeState.subagent_invocations || 0) + (subagents.length > 0 ? subagents.length : 1);
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

      const ackToolCallId = payload.toolCall?.id || payload.toolCallId || "";
      const inFlight = activeState.investigationInFlight || null;
      const inFlightToolCallId = inFlight?.toolCallId || inFlight?.tool_call_id || "";
      const inFlightParentConversationId = inFlight?.parentConversationId || inFlight?.parent_conversation_id || inFlight?.conversationId || inFlight?.conversation_id || null;
      const sameInvestigationParent = Boolean(
        inFlight &&
        (!inFlightParentConversationId || inFlightParentConversationId === conversationId)
      );
      // State-changing dispatch failure and child-id enrichment require exact causal identity.
      const isInvestigationAck = Boolean(
        sameInvestigationParent &&
        inFlightToolCallId &&
        ackToolCallId &&
        inFlightToolCallId === ackToolCallId
      );
      const invocationFailed = Boolean(
        payload.error ||
        payload.toolResult?.error ||
        payload.cancelled ||
        payload.result?.cancelled ||
        payload.result?.status === "FAILED" ||
        payload.result?.status === "CANCELLED" ||
        (typeof payload.toolResult === "string" && /FAILED|CANCELLED/i.test(payload.toolResult))
      );
      const returnedChildId = payload.result?.conversationId || payload.result?.subagentId || payload.childConversationId || payload.subagentId || null;

      // Successful invoke_subagent is only an acknowledgement that delegation was accepted.
      // It is NOT factual completion of an asynchronous investigation.
      if (isInvestigationAck && !invocationFailed) {
        activeState.investigationInFlight.acknowledged_at = new Date().toISOString();
        if (returnedChildId && !activeState.investigationInFlight.childConversationId) {
          activeState.investigationInFlight.childConversationId = returnedChildId;
          activeState.investigationInFlight.child_conversation_id = returnedChildId;
          activeState.investigationInFlight.subagentId = returnedChildId;
          activeState.investigationInFlight.subagent_id = returnedChildId;
        }
      }

      // invoke_subagent PostToolUse is dispatch acknowledgement, not delegated-work completion.
      // Successful ACKs NEVER close Dream outcomes. Only a factual dispatch failure with
      // exact causal identity may close the corresponding pending decision here.
      if (invocationFailed && ackToolCallId) {
        try {
          const branchCount = Math.max(1, subagents.length);
          const stepIdx = payload.stepIdx ?? 0;

          for (let idx = 0; idx < branchCount; idx++) {
            const corrKey = dreamCorrelationKey({
              conversationId,
              stepIdx,
              toolCallId: ackToolCallId,
              branchOrdinal: idx,
            });
            const pendingCheck = getPendingDecision({ repoRoot, correlationKey: corrKey });
            if (!pendingCheck.ok) continue;

            const evidenceSummary = activeState.evidenceSummary || activeState.evidence || {
              tests: activeState.workerValidationVerified ? "PASS" : (activeState.workerValidationExitCode !== null && activeState.workerValidationExitCode !== 0 ? "FAIL" : "UNKNOWN"),
              typecheck: "UNKNOWN",
              build: "UNKNOWN",
              validation_fresh: Boolean(activeState.workerValidationFresh),
              scope_check: "UNKNOWN",
            };

            recordDecisionOutcome({
              repoRoot,
              correlationKey: corrKey,
              outcome: {
                result: {
                  status: payload.cancelled || payload.result?.cancelled || payload.result?.status === "CANCELLED"
                    ? "CANCELLED"
                    : "DISPATCH_FAILED",
                  error: payload.error || payload.toolResult?.error || null,
                },
                evidence_summary: evidenceSummary,
                mutation_seq: activeState.mutationSeq || activeState.mutation_seq || 0,
                retry_state: {
                  attempt: activeState.attempt || 0,
                  retry_remaining: activeState.retry_remaining ?? activeState.remainingAttempts ?? 0,
                  retry_reason: activeState.retryReason || activeState.retry_reason || null,
                },
                cost_metrics: {
                  tool_calls: activeState.tool_calls || 1,
                  context_proxy_bytes: activeState.context_proxy_bytes || 0,
                  worker_packet_bytes: activeState.toolMix?.worker_packet_bytes || activeState.worker_packet_bytes || 0,
                  duration_ms: payload.durationMs ?? 0,
                },
                terminal_state: "FAILED",
              },
            });
          }
        } catch {
          // Fail-open: Dream telemetry must never break runtime execution.
        }
      }

      // Only a factual invocation failure may terminate the attempt here.
      // Successful ACKs remain in-flight until the investigator child reaches its terminal Stop boundary.
      if (isInvestigationAck && invocationFailed) {
        activeState.post_investigation = false;
        activeState.postInvestigation = false;
        activeState.investigation_dispatch_failed_at = new Date().toISOString();
        delete activeState.investigationInFlight;
      }
    } else if (toolName === "manage_subagents") {
      activeState.manage_subagents_calls = (activeState.manage_subagents_calls || 0) + 1;
      if (payload.result) {
        activeState.worker_completion_events = (activeState.worker_completion_events || 0) + 1;
        const compBytes = Buffer.byteLength(JSON.stringify(payload.result), "utf-8");
        activeState.worker_completion_packet_bytes = (activeState.worker_completion_packet_bytes || 0) + compBytes;
        activeState.handoffObserved = true;
        activeState.handoffBytes = (activeState.handoffBytes || 0) + compBytes;
        activeState.handoffStatus = "COMPLETION_RECEIVED";
      }
      // manage_subagents is observability/recovery, not a causal completion boundary.
      // It must never satisfy post_investigation. Factual investigator termination is handled by Stop.
    } else if (toolName === "send_message") {
      activeState.send_message_calls = (activeState.send_message_calls || 0) + 1;
      const msg = toolArgs.Message || "";
      const isFactualImplementationWorker =
        isWorkerRole(actor.role) &&
        actor.confidence === "HIGH" &&
        actor.source === "RUNTIME_IDENTITY" &&
        actor.delegationKind === "WORK";
      if (msg) {
        const pBytes = Buffer.byteLength(String(msg), "utf-8");
        activeState.toolMix.worker_packet_chars = (activeState.toolMix.worker_packet_chars || 0) + msg.length;
        activeState.toolMix.worker_packet_bytes = (activeState.toolMix.worker_packet_bytes || 0) + pBytes;
        activeState.worker_packet_bytes = (activeState.worker_packet_bytes || 0) + pBytes;
        activeState.handoffObserved = true;
        activeState.handoffBytes = (activeState.handoffBytes || 0) + pBytes;
        activeState.handoffStatus = "MESSAGE_DELIVERED";
        if (isFactualImplementationWorker) {
          activeState.workerConversationId = conversationId;
        }
        const msgStr = typeof msg === "string" ? msg : JSON.stringify(msg);
        if (msgStr.includes("IMPLEMENTATION_COMPLETE")) {
          if (isFactualImplementationWorker) {
            activeState.workerCompletionClaimed = true;
            activeState.workerCompletionClaimFactual = true;
            activeState.workerCompletionClaimTimestamp = new Date().toISOString();
            activeState.workerCompletionClaimIdentity = {
              actorId: actor.actorId || conversationId || null,
              source: actor.source,
              confidence: actor.confidence,
              delegationKind: actor.delegationKind,
              attempt: Number.isInteger(actor.attempt) ? actor.attempt : 0,
            };
            activeState.implementationComplete = true;
          } else {
            activeState.nonFactualCompletionClaims = (activeState.nonFactualCompletionClaims || 0) + 1;
            activeState.lastNonFactualCompletionClaim = {
              actorId: actor.actorId || conversationId || null,
              role: actor.role || "UNKNOWN",
              source: actor.source || "UNRESOLVED",
              confidence: actor.confidence || "LOW",
              delegationKind: actor.delegationKind || null,
              attempt: Number.isInteger(actor.attempt) ? actor.attempt : null,
              timestamp: new Date().toISOString(),
            };
          }

          const matchCmd = msgStr.match(/(?:verified with\s+)?(node\s+--test|npm\s+test|pnpm\s+test|pytest|cargo\s+test|vitest|jest)[^\n\r\]]*/i);
          if (matchCmd) {
            activeState.claimedValidationCommand = matchCmd[0].replace(/^verified\s+with\s+/i, "").trim();
          }
          const matchTests = msgStr.match(/TESTS:\s*\[?([^\n\r\]]+)\]?/i);
          if (matchTests) {
            activeState.claimedTestsPassed = matchTests[1].trim();
          }
          const matchExit = msgStr.match(/exit(?:_?\s*code)?[:\s=]+(\d+)/i);
          if (matchExit) {
            activeState.claimedValidationExitCode = parseInt(matchExit[1], 10);
          }
        }
      }
    }

    // Sequence mutation tracking: before first mutation vs after last mutation
    const isMutationStep = ["write_to_file", "replace_file_content", "edit_file", "create_file"].includes(toolName)
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
        recordedEvidence.actorRole = actor.role;
        recordedEvidence.actorId = actor.actorId || conversationId || null;
        recordedEvidence.conversationId = conversationId || null;
        recordedEvidence.confidence = actor.confidence || "LOW";
        recordedEvidence.evidenceSource = actor.source || "EXECUTION_HOOK";
        recordedEvidence.delegationKind = actor.delegationKind || null;
        recordedEvidence.attempt = Number.isInteger(actor.attempt) ? actor.attempt : null;

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

    // Evaluate worker validation verification against authoritative Evidence Ledger
    const valEval = verifyTaskEvidence(activeState);
    activeState.workerValidationVerified = valEval.verified;
    activeState.workerValidationFresh = valEval.fresh;
    if (valEval.verified && valEval.evidence) {
      activeState.workerValidationExecutionId = valEval.evidence.executionId || activeState.workerValidationExecutionId;
      activeState.workerValidationCommand = valEval.evidence.command || activeState.workerValidationCommand;
      activeState.workerValidationExitCode = valEval.evidence.exitCode ?? activeState.workerValidationExitCode;
      activeState.workerValidationActor = valEval.evidence.actorRole || activeState.workerValidationActor;
    }

    if (activeState.workerCompletionClaimed && activeState.workerValidationVerified) {
      activeState.state = "EVIDENCE_READY";
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
      worker_completion_claimed: activeState.workerCompletionClaimed || false,
      worker_validation_observed: activeState.workerValidationObserved || false,
      worker_validation_verified: activeState.workerValidationVerified || false,
      worker_validation_exit_code: activeState.workerValidationExitCode ?? null,
      worker_validation_actor: activeState.workerValidationActor || null,
      worker_validation_fresh: activeState.workerValidationFresh || false,
      type: "TOOL_STEP"
    };

    appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
  } catch {}

  console.log(JSON.stringify({}));
}

main();
