import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative, dirname, basename, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  extractRealShellRedirections,
  TOOL_OUTPUT_LIMITS,
  POLLING_POLICY,
  checkPollingBudget,
  isControlPlanePath,
  classifyScopeSpecificity,
  isConcretePath,
  isHealthyDelegatedExecution,
  isOrchestratorRole,
  checkValidationCompletionLock,
  isValidationCommand,
  validateStateTransition,
} from "../skills/agy-orchestra/routing-policy.mjs";
import { buildSnapshot } from "../dream/snapshot.mjs";
import {
  DECISION_TYPES,
  deriveDecisionState,
  deriveAvailableActions,
  classifyBaselineDecision,
  deriveValidatedStaticBaseline,
} from "../dream/action-space.mjs";
import { recordDecision, dreamCorrelationKey } from "../dream/decision-recorder.mjs";
import { DREAM_SCHEMAS } from "../dream/records.mjs";
import {
  evaluatePolicy,
  computePolicyId,
  validatePolicy,
} from "../dream/policy-engine.mjs";

const WORKER_ACTION_TO_PROFILE = Object.freeze({
  FLASH_LOW: "flash-low-worker",
  FLASH_MEDIUM: "flash-medium-worker",
  FLASH_HIGH: "flash-worker",
});

const PROFILE_TO_WORKER_ACTION = Object.freeze({
  "flash-low-worker": "FLASH_LOW",
  "flash-medium-worker": "FLASH_MEDIUM",
  "flash-worker": "FLASH_HIGH",
});

function loadActivePolicy() {
  const activePolicyPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dream/policies/static-policy-v1.json");
  if (!existsSync(activePolicyPath)) {
    return { policy: null, diagnostic: "MISSING_POLICY" };
  }
  let raw = "";
  try {
    raw = readFileSync(activePolicyPath, "utf-8");
  } catch {
    return { policy: null, diagnostic: "MISSING_POLICY" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { policy: null, diagnostic: "MALFORMED_JSON" };
  }
  if (!parsed || typeof parsed !== "object" || parsed.schema !== DREAM_SCHEMAS.POLICY) {
    return { policy: parsed, diagnostic: "UNSUPPORTED_SCHEMA" };
  }
  try {
    const computedId = computePolicyId(parsed);
    if (parsed.policy_id !== computedId) {
      return { policy: parsed, diagnostic: "POLICY_HASH_MISMATCH" };
    }
  } catch {
    return { policy: parsed, diagnostic: "INVALID_POLICY" };
  }
  const val = validatePolicy(parsed);
  if (!val.valid) {
    return { policy: parsed, diagnostic: "INVALID_POLICY" };
  }
  return { policy: parsed, diagnostic: null };
}

function evaluatePolicyWithFallback({ decisionType, state, availableActions, baselineAction }) {
  const loaded = loadActivePolicy();
  const safeBaseline = typeof baselineAction === "string" ? baselineAction : "";
  if (loaded.diagnostic) {
    return {
      ok: false,
      action: safeBaseline,
      source: "STATIC_ROUTING_FALLBACK",
      policy_id: loaded.policy?.policy_id || null,
      baseline_action: safeBaseline,
      policy_diagnostic: loaded.diagnostic,
    };
  }
  try {
    const evalRes = evaluatePolicy({
      policy: loaded.policy,
      decisionType,
      state,
      availableActions,
      baselineAction: safeBaseline,
    });
    if (evalRes.ok) {
      return {
        ok: true,
        action: evalRes.action,
        source: "STATIC_POLICY_V1",
        policy_id: evalRes.policy_id,
        baseline_action: safeBaseline,
        policy_diagnostic: null,
      };
    }
    let diag = "INTERPRETER_EXCEPTION";
    if (evalRes.diagnostic?.includes("POLICY_CONFLICT")) diag = "POLICY_CONFLICT";
    else if (evalRes.diagnostic?.includes("POLICY_INVALID_ACTION")) diag = "POLICY_INVALID_ACTION";
    else if (evalRes.diagnostic?.includes("NO_MATCHING_RULE")) diag = "NO_MATCHING_RULE";
    else if (evalRes.diagnostic?.includes("INVALID_POLICY")) diag = "INVALID_POLICY";
    return {
      ok: false,
      action: evalRes.action || safeBaseline,
      source: "STATIC_ROUTING_FALLBACK",
      policy_id: evalRes.policy_id || loaded.policy?.policy_id || null,
      baseline_action: safeBaseline,
      policy_diagnostic: diag,
    };
  } catch {
    return {
      ok: false,
      action: safeBaseline,
      source: "STATIC_ROUTING_FALLBACK",
      policy_id: loaded.policy?.policy_id || null,
      baseline_action: safeBaseline,
      policy_diagnostic: "INTERPRETER_EXCEPTION",
    };
  }
}

export function startPendingInvestigationRequirement({ activeState, statePath, repoRoot, payload, toolCall, sub, activeRole, activeContract }) {
  const req = activeState.pendingPolicyRequirement;
  if (!req || req.selected_action !== "INVESTIGATE_FIRST") return;

  const taskObj = {
    spec: activeState.taskSpec || "Investigation execution",
    task_action: activeState.taskAction || activeState.task_action || "IMPLEMENT",
    task_domain: activeState.taskDomain || activeState.task_domain || "CODE",
    criticality: activeState.criticality || "NORMAL",
  };
  const snapRes = buildSnapshot({
    repoRoot,
    task: taskObj,
    contract: activeContract || { allowed_paths: [], forbidden_paths: [".agents/**"], criticality: "NORMAL" },
    runtime: { node_version: process.version, platform: process.platform, arch: process.arch, schema_version: DREAM_SCHEMAS.SNAPSHOT },
    executionState: { step_sequence: payload?.stepIdx ?? 0, attempt: activeState.attempt || 0, retry_remaining: activeState.retry_remaining ?? 0, mutation_seq: activeState.mutationSeq || 0 },
    evidence: activeState.evidenceSummary || activeState.evidence || { tests: "UNKNOWN", typecheck: "UNKNOWN", build: "UNKNOWN", validation_fresh: false, scope_check: "UNKNOWN" },
  });
  const corrKey = dreamCorrelationKey({
    conversationId: payload?.conversationId || activeState.conversationId || "default",
    stepIdx: payload?.stepIdx ?? 0,
    toolCallId: toolCall?.id || payload?.toolCallId || "",
    branchOrdinal: 0,
  });
  if (snapRes.ok) {
    const decState = deriveDecisionState(taskObj, activeState, activeState.evidenceSummary || activeState.evidence || {});
    const availableActions = deriveAvailableActions(req.decision_type || DECISION_TYPES.INVESTIGATION_STRATEGY, decState);
    recordDecision({
      repoRoot,
      snapshot: snapRes.snapshot,
      decision: {
        decision_type: req.decision_type || DECISION_TYPES.INVESTIGATION_STRATEGY,
        state: decState,
        available_actions: availableActions.length > 0 ? availableActions : ["IMPLEMENT_DIRECT", "INVESTIGATE_FIRST"],
        chosen_action: "INVESTIGATE_FIRST",
        policy_source: req.policy_source || "STATIC_POLICY_V1",
        policy_id: req.policy_id || null,
        baseline_action: req.baseline_action || "IMPLEMENT_DIRECT",
        policy_diagnostic: req.policy_diagnostic || null,
        actor_identity: activeRole || "ORCHESTRATOR",
        conversation_id: payload?.conversationId || activeState.conversationId || "default",
        step_idx: payload?.stepIdx ?? 0,
        tool_call_id: toolCall?.id || payload?.toolCallId || "",
        branch_ordinal: 0,
      },
      correlationKey: corrKey,
    });
  }

  const childId = sub?.childConversationId || sub?.child_conversation_id || sub?.conversationId || sub?.subagentId || sub?.subagent_id || null;
  const execId = payload?.executionId || toolCall?.args?.executionId || sub?.executionId || null;

  // Convert pending requirement to investigationInFlight (post_investigation remains false until completed)
  activeState.investigationInFlight = {
    correlationKey: corrKey,
    correlation_key: corrKey,
    decision_type: req.decision_type || DECISION_TYPES.INVESTIGATION_STRATEGY,
    policy_source: req.policy_source || "STATIC_POLICY_V1",
    policy_id: req.policy_id || null,
    toolCallId: toolCall?.id || payload?.toolCallId || "",
    tool_call_id: toolCall?.id || payload?.toolCallId || "",
    executionId: execId,
    execution_id: execId,
    childConversationId: childId,
    child_conversation_id: childId,
    subagentId: childId,
    subagent_id: childId,
    stepIdx: payload?.stepIdx ?? 0,
    step_idx: payload?.stepIdx ?? 0,
    conversationId: payload?.conversationId || activeState.conversationId || "default",
    conversation_id: payload?.conversationId || activeState.conversationId || "default",
    parentConversationId: payload?.parentConversationId || activeState.parentConversationId || payload?.conversationId || activeState.conversationId || null,
    parent_conversation_id: payload?.parentConversationId || activeState.parentConversationId || payload?.conversationId || activeState.conversationId || null,
    delegationKind: "INVESTIGATION",
    delegation_kind: "INVESTIGATION",
    subagentRole: sub?.Role || sub?.role || "investigator",
    subagent_role: sub?.Role || sub?.role || "investigator",
    subagentProfile: sub?.TypeName || sub?.profile || "flash-worker",
    subagent_profile: sub?.TypeName || sub?.profile || "flash-worker",
    started_at: new Date().toISOString(),
  };
  delete activeState.pendingPolicyRequirement;
  activeState.post_investigation = false;
  activeState.postInvestigation = false;
  if (statePath) {
    try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
  }
}

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

function pathMatchesPattern(filePath, pattern) {
  const normPath = normalizePath(filePath);
  const normPattern = normalizePath(pattern);
  if (normPattern.endsWith("/**")) {
    const prefix = normPattern.slice(0, -3).replace(/\/$/, "");
    return normPath === prefix || normPath.startsWith(prefix + "/");
  }
  if (normPattern.endsWith("/*")) {
    const prefix = normPattern.slice(0, -2).replace(/\/$/, "");
    const rest = normPath.slice(prefix.length + 1);
    return normPath.startsWith(prefix + "/") && !rest.includes("/");
  }
  return normPath === normPattern;
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
    pendingExecutionsDir: resolve(repoRoot, ".agents/state/executions/pending"),
  };
}

function loadRoleBindings(roleBindingsPath) {
  if (existsSync(roleBindingsPath)) {
    try {
      return JSON.parse(readFileSync(roleBindingsPath, "utf-8"));
    } catch {}
  }
  return { mainConversationId: null, bindings: {}, pendingSubagents: [] };
}

function saveRoleBindings(roleBindingsPath, data) {
  try {
    mkdirSync(dirname(roleBindingsPath), { recursive: true });
    writeFileSync(roleBindingsPath, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

function recordDeniedAttempt(activeState, statePath, toolName, toolArgs, reason) {
  if (!activeState || !statePath) return;
  if (!Array.isArray(activeState.deniedAttempts)) {
    activeState.deniedAttempts = [];
  }
  activeState.deniedAttempts.push({
    tool: toolName,
    args: toolArgs || {},
    timestamp: Date.now(),
    reason,
  });
  try {
    writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
  } catch {}
}

function resolveActorIdentity(payload = {}, activeState = {}, roleBindings = {}, repoRoot = "", roleBindingsPath = "") {
  const convId = payload.conversationId || null;

  // 1. Check exact conversationId in role-bindings
  if (convId) {
    const existing = (roleBindings.bindings && roleBindings.bindings[convId])
      || (roleBindings.conversations && roleBindings.conversations[convId]);
    if (existing) {
      return {
        role: existing.role,
        source: existing.source || "CONVERSATION_BOUND_IDENTITY",
        confidence: "HIGH",
        actorId: convId,
        agentProfile: existing.profile || null,
        model: existing.model || payload.modelName || null,
      };
    }

    // Matches main conversation ID
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

    // Different conversationId than main -> child subagent correlation
    if ((roleBindings.mainConversationId && convId !== roleBindings.mainConversationId) || (Array.isArray(roleBindings.pendingSubagents) && roleBindings.pendingSubagents.length > 0)) {
      const pendingList = Array.isArray(roleBindings.pendingSubagents) ? roleBindings.pendingSubagents : [];
      const unconsumed = pendingList.filter((p) => !p.consumed);

      if (unconsumed.length > 0) {
        let matched = null;

        // Try to distinguish based on available evidence from payload
        const reqRole = (payload.agentRole || payload.role || "").toUpperCase();
        const reqProfile = payload.agentProfile || payload.typeName || payload.profile || "";
        const reqModel = payload.modelName || "";

        let candidates = unconsumed;
        // Filter by parent/task/run context before matching role/profile:
        const parentConvId = payload.parentConversationId || activeState.parentConversationId || roleBindings.mainConversationId || null;
        if (parentConvId) {
          candidates = candidates.filter((c) => c.parentConversationId && c.parentConversationId === parentConvId);
        }
        const activeTaskId = payload.taskId || payload.taskIdentifier || activeState.taskId || activeState.taskKey || process.env.BENCHMARK_TASK_ID || null;
        if (activeTaskId) {
          candidates = candidates.filter((c) => (c.taskIdentifier || c.taskId) && (c.taskIdentifier || c.taskId) === activeTaskId);
        }
        const activeRunId = payload.benchmarkRunId || activeState.benchmarkRunId || process.env.BENCHMARK_RUN_ID || null;
        if (activeRunId) {
          candidates = candidates.filter((c) => c.benchmarkRunId && c.benchmarkRunId === activeRunId);
        }

        if (reqRole) {
          candidates = candidates.filter((c) => c.role && c.role.toUpperCase() === reqRole);
        }
        if (reqProfile) {
          candidates = candidates.filter((c) => c.profile === reqProfile || c.typeName === reqProfile);
        }
        if (reqModel) {
          candidates = candidates.filter((c) => c.model === reqModel || (c.model && reqModel.includes(c.model)));
        }

        if (candidates.length === 1) {
          matched = candidates[0];
        } else if (candidates.length > 1) {
          // If multiple candidates share the exact same role and profile (e.g. Two-Key reviewers), safe to bind FIFO
          const firstRole = candidates[0].role;
          const firstProfile = candidates[0].profile;
          const allSameRoleAndProfile = candidates.every((c) => c.role === firstRole && c.profile === firstProfile);
          const homogeneousReviewerPair = allSameRoleAndProfile
            && firstRole === "REVIEWER"
            && candidates.every((c) => c.delegationKind === "REVIEW");
          if (homogeneousReviewerPair) {
            matched = candidates[0];
          } else {
            // Ambiguous candidates with different roles/profiles fail closed
            matched = null;
          }
        } else {
          matched = null;
        }

        if (matched) {
          const consumedAt = new Date().toISOString();
          matched.consumed = true;
          matched.consumedBy = convId;
          matched.consumedAt = consumedAt;

          const childRole = matched.role || null;
          const childProfile = matched.profile || matched.typeName || null;
          const childModel = matched.model || payload.modelName || (childRole === "REVIEWER" ? "gemini-3.8-flash-high" : null);

          const isFactualIdentity = Boolean(childRole && childProfile);
          const confidence = isFactualIdentity ? "HIGH" : "LOW";
          const source = isFactualIdentity ? "RUNTIME_IDENTITY" : "UNRESOLVED";

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
            originToolCallId: matched.originToolCallId || matched.toolCallId || null,
            originStepIdx: matched.originStepIdx ?? null,
            pendingSeq: matched.seq ?? null,
            delegationKind: matched.delegationKind || null,
            decisionCorrelationKey: matched.decisionCorrelationKey || null,
            decisionType: matched.decisionType || null,
            decisionBranchOrdinal: matched.decisionBranchOrdinal ?? null,
            confidence,
            source,
            consumed: true,
            consumedBy: convId,
            consumedAt,
          };
          roleBindings.bindings[convId] = record;
          roleBindings.conversations[convId] = record;
          if (roleBindingsPath) {
            saveRoleBindings(roleBindingsPath, roleBindings);
          }
          if (!isFactualIdentity) {
            return {
              role: "UNKNOWN",
              source: "UNRESOLVED",
              confidence: "LOW",
              actorId: convId,
            };
          }
          return {
            role: childRole,
            source: "RUNTIME_IDENTITY",
            confidence: "HIGH",
            actorId: convId,
            agentProfile: childProfile,
            model: childModel,
          };
        }
      }
    }
  }

  // 2. State-derived role
  const stateRole = String(activeState.activeRole || activeState.role || "").toUpperCase();
  if (stateRole) {
    if (isReviewerRole(stateRole)) {
      return {
        role: "REVIEWER",
        source: "STATE_DERIVED",
        confidence: "MEDIUM",
        actorId: convId,
        agentProfile: "flash-reviewer",
        model: payload.modelName || "gemini-3.8-flash-high",
      };
    }
    if (isOrchestratorRole(stateRole)) {
      if (roleBindings.mainConversationId && convId && convId !== roleBindings.mainConversationId) {
        return {
          role: "UNKNOWN",
          source: "UNRESOLVED",
          confidence: "LOW",
          actorId: convId,
        };
      }
      return {
        role: "ORCHESTRATOR",
        source: "STATE_DERIVED",
        confidence: "MEDIUM",
        actorId: convId,
        agentProfile: "flash-orchestrator",
        model: payload.modelName || "gemini-3.8-flash-medium",
      };
    }
    if (isWorkerRole(stateRole)) {
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

  // 3. Fallback: If conversationId is present, no pending subagents exist yet, and role-bindings has no main,
  // this is the initial main agent conversation (Flash Orchestrator)
  if (convId && !roleBindings.mainConversationId && (!Array.isArray(roleBindings.pendingSubagents) || roleBindings.pendingSubagents.length === 0)) {
    if (stateRole && isOrchestratorRole(stateRole)) {
      roleBindings.mainConversationId = convId;
      if (!roleBindings.bindings) roleBindings.bindings = {};
      if (!roleBindings.conversations) roleBindings.conversations = {};
      const orchRecord = {
        role: "ORCHESTRATOR",
        profile: "flash-orchestrator",
        model: payload.modelName || "gemini-3.8-flash-medium",
        source: "CONVERSATION_BOUND_IDENTITY",
      };
      roleBindings.bindings[convId] = orchRecord;
      roleBindings.conversations[convId] = orchRecord;
      if (roleBindingsPath) {
        saveRoleBindings(roleBindingsPath, roleBindings);
      }
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

function checkLargeFileGuard(cmd, repoRoot) {
  const trimmed = cmd.trim();
  const dumpPatterns = [
    /^\s*cat\s+([^\s;&|<>]+)/,
    /^\s*jq\s+['"]\.['"]\s+([^\s;&|<>]+)/,
    /^\s*jq\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)$/,
  ];

  for (const pattern of dumpPatterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].replace(/["']/g, "");
      if (candidate.startsWith("-")) continue;
      const fullPath = resolve(repoRoot, candidate);
      if (existsSync(fullPath)) {
        try {
          const stats = statSync(fullPath);
          const limit = TOOL_OUTPUT_LIMITS.largeFileThresholdBytes;
          if (stats.size > limit) {
            return {
              blocked: true,
              reason: `LARGE_FILE_GUARD: Target file "${candidate}" is ${Math.round(stats.size / 1024)} KB (exceeds threshold ${limit / 1024} KB). Direct dumping of large files into context is blocked. Use filtered inspection (e.g. jq with specific query, head/tail, grep, or a script to summarize to an artifact).`
            };
          }
        } catch {}
      }
    }
  }

  return { blocked: false };
}

function extractTargetPaths(commandLine, repoRoot) {
  const targets = new Set();
  const cmd = commandLine.trim();

  // 1. Real Redirections: > or >> (parsed with deterministic scanner)
  const redir = extractRealShellRedirections(cmd);
  for (const rawPath of redir.targets) {
    targets.add(rawPath);
  }

  // 2. sed -i
  if (/\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b/.test(cmd)) {
    const tokens = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i].replace(/["']/g, "");
      if (t.startsWith("-")) continue;
      if (/^s[^\w\s]/.test(t) || /^y[^\w\s]/.test(t) || /^d$/.test(t)) continue;
      if (t.includes("/") || /\.(ts|tsx|js|mjs|json|md|py|sh|css|html)$/.test(t)) {
        targets.add(t);
      }
    }
  }

  // 3. rm, mv, cp, touch, truncate
  const fileOpRegex = /\b(rm|mv|cp|touch|truncate)\s+([^;&|]+)/g;
  let match;
  while ((match = fileOpRegex.exec(cmd)) !== null) {
    const op = match[1];
    const rest = match[2];
    const tokens = rest.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const nonFlags = tokens.filter(t => !t.startsWith("-")).map(t => t.replace(/["']/g, ""));
    nonFlags.forEach(t => targets.add(t));
  }

  // 4. tee
  const teeRegex = /\btee\s+(?:-[a-zA-Z]+\s+)*([^\s;&|]+)/g;
  while ((match = teeRegex.exec(cmd)) !== null) {
    const t = match[1].replace(/["']/g, "");
    if (!t.startsWith("-") && t !== "/dev/null") targets.add(t);
  }

  // 5. Inline python/node writes
  const nodeWriteRegex = /writeFileSync\s*\(\s*["']([^"']+)["']/g;
  while ((match = nodeWriteRegex.exec(cmd)) !== null) {
    targets.add(match[1]);
  }
  const pyWriteRegex = /open\s*\(\s*["']([^"']+)["']\s*,\s*["'][wa]/g;
  while ((match = pyWriteRegex.exec(cmd)) !== null) {
    targets.add(match[1]);
  }

  // Normalize targets relative to repoRoot
  const result = [];
  for (const t of targets) {
    let p = t;
    if (p.startsWith(repoRoot)) {
      p = relative(repoRoot, p);
    }
    result.push(normalizePath(p));
  }
  return result;
}


function isReadOnlyCommand(cmd) {
  const trimmed = cmd.trim();
  const redir = extractRealShellRedirections(cmd);
  if (redir.targets.length > 0) return false;

  if (/\b(sed\s+-[a-zA-Z]*i|rm\s+|mv\s+|cp\s+|touch\s+|truncate\s+|tee\s+|writeFileSync|open\(.+["'][wa])\b/.test(cmd)) {
    return false;
  }

  return (
    trimmed.startsWith("git diff") ||
    trimmed.startsWith("git status") ||
    trimmed.startsWith("git log") ||
    trimmed.startsWith("git show") ||
    trimmed.startsWith("git grep") ||
    trimmed.startsWith("git branch") ||
    trimmed.startsWith("git rev-parse") ||
    trimmed.startsWith("ls") ||
    trimmed.startsWith("cat ") ||
    trimmed.startsWith("head ") ||
    trimmed.startsWith("tail ") ||
    trimmed.startsWith("grep ") ||
    trimmed.startsWith("rg ") ||
    trimmed.startsWith("find ") ||
    trimmed.startsWith("which ") ||
    trimmed.startsWith("whereis ") ||
    trimmed.startsWith("pwd") ||
    trimmed.startsWith("echo ") ||
    trimmed.startsWith("printf ") ||
    trimmed.startsWith("wc ") ||
    trimmed.startsWith("stat ") ||
    trimmed.startsWith("file ") ||
    trimmed.startsWith("du ") ||
    trimmed.startsWith("df ") ||
    trimmed.startsWith("node -v") ||
    trimmed.startsWith("node --version") ||
    trimmed.startsWith("npm -v") ||
    trimmed.startsWith("npm --version") ||
    trimmed.startsWith("pnpm -v") ||
    trimmed.startsWith("pnpm --version") ||
    trimmed.startsWith("yarn -v") ||
    trimmed.startsWith("yarn --version") ||
    trimmed.startsWith("python3 --version") ||
    trimmed.startsWith("python --version") ||
    trimmed.startsWith("agy ")
  );
}

function isWorkerRole(role) {
  return role === "WORKER" || role === "FLASH" || role === "FLASH_WORKER" || role === "FLASH_MEDIUM_WORKER" || role === "FLASH_LOW_WORKER";
}

function isReviewerRole(role) {
  return role === "REVIEWER" || role === "FLASH_REVIEWER" || role === "OPUS";
}

function extractScopeContractFromPrompt(promptText = "", sub = {}) {
  let allowed = [];
  let forbidden = [];
  let tests = [];

  if (sub.ScopeContract || sub.scopeContract) {
    const sc = sub.ScopeContract || sub.scopeContract;
    if (Array.isArray(sc.allowedPaths)) allowed = sc.allowedPaths;
    if (Array.isArray(sc.forbiddenPaths)) forbidden = sc.forbiddenPaths;
    if (Array.isArray(sc.testsRequired)) tests = sc.testsRequired;
  }

  if (allowed.length === 0 && typeof promptText === "string") {
    const allowedMatch = promptText.match(/allowedPaths\s*:\s*\[([^\]]*)\]/i);
    if (allowedMatch && allowedMatch[1]) {
      allowed = allowedMatch[1]
        .split(",")
        .map(s => s.trim().replace(/^["'`]|["'`]$/g, ""))
        .filter(Boolean);
    }
  }

  if (forbidden.length === 0 && typeof promptText === "string") {
    const forbiddenMatch = promptText.match(/forbiddenPaths\s*:\s*\[([^\]]*)\]/i);
    if (forbiddenMatch && forbiddenMatch[1]) {
      forbidden = forbiddenMatch[1]
        .split(",")
        .map(s => s.trim().replace(/^["'`]|["'`]$/g, ""))
        .filter(Boolean);
    }
  }

  if (tests.length === 0 && typeof promptText === "string") {
    // 1. Explicit array in testsRequired: [...]
    const arrayMatch = promptText.match(/testsRequired\s*:\s*(\[[^\]]+\])/i);
    if (arrayMatch && arrayMatch[1]) {
      try {
        tests = JSON.parse(arrayMatch[1]);
      } catch {
        tests = arrayMatch[1].slice(1, -1).split(",").map(s => s.trim().replace(/^["'`]|["'`]$/g, "")).filter(Boolean);
      }
    }

    // 2. Explicit backticked test command anywhere in validation instructions
    if (tests.length === 0) {
      const codeMatch = promptText.match(/`((?:node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|pytest|cargo\s+test|vitest|jest)[^`\n]+)`/i);
      if (codeMatch && codeMatch[1]) {
        tests = [codeMatch[1].trim()];
      }
    }

    // 3. Structured line testsRequired: ... or Validate using: ...
    if (tests.length === 0) {
      const testMatch = promptText.match(/(?:testsRequired|Validate(?: changes)?(?: using)?)\s*:\s*`?([^`\n]+)`?/i);
      if (testMatch && testMatch[1]) {
        let raw = testMatch[1].trim().replace(/^["'`]|["'`]$/g, "");
        if (raw.toLowerCase() !== "true" && raw.toLowerCase() !== "false") {
          tests = [raw];
        }
      }
    }
  }

  if (allowed.length === 0 && typeof promptText === "string") {
    const fileMatches = promptText.match(/\b(?:src|test|lib|packages)\/[\w./-]+\.(?:js|mjs|ts|json)\b/g);
    if (fileMatches && fileMatches.length > 0) {
      allowed = [...new Set(fileMatches)];
    }
  }

  return {
    allowedPaths: allowed,
    forbiddenPaths: forbidden,
    testsRequired: tests,
  };
}

export function isValidAgentName(name) {
  if (!name || typeof name !== "string") return false;
  const clean = name.trim().replace(/^["']|["']$/g, "").trim();
  if (!clean || clean === "." || clean === "..") return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) return false;
  if (clean.includes("..") || clean.includes("/") || clean.includes("\\")) return false;
  return true;
}

function main() {
  const rawInput = readStdin();
  if (!rawInput.trim()) {
    console.log(JSON.stringify({ decision: "allow" }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    console.log(JSON.stringify({ decision: "allow" }));
    return;
  }

  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || "";
  const toolArgs = toolCall.args || {};

  const { repoRoot, statePath, contractPath, roleBindingsPath, pendingExecutionsDir } = getWorkspacePaths(payload);

  let activeState = {};
  let activeContract = null;

  if (existsSync(statePath)) {
    try {
      activeState = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {}
  }

  if (existsSync(contractPath)) {
    try {
      activeContract = JSON.parse(readFileSync(contractPath, "utf-8"));
    } catch {}
  } else if (activeState.scopeContract) {
    activeContract = activeState.scopeContract;
  }

  const roleBindings = loadRoleBindings(roleBindingsPath);
  const actor = resolveActorIdentity(payload, activeState, roleBindings, repoRoot, roleBindingsPath);
  const activeRole = actor.role;
  const isDirectAction = activeState.taskAction === "DIRECT_ACTION" || activeState.isDirectAction === true;

  // Check 1: Worker or Reviewer spawning subagents, OR any subagent during DIRECT_ACTION
  if (toolName === "invoke_subagent" || toolName === "define_subagent") {
    if (isDirectAction) {
      if (!activeState.toolMix) activeState.toolMix = {};
      activeState.toolMix.direct_action_side_quests_prevented = (activeState.toolMix.direct_action_side_quests_prevented || 0) + 1;
      try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
      console.log(JSON.stringify({
        decision: "deny",
        reason: "DIRECT_ACTION_SUBAGENT_PROHIBITED: DIRECT_ACTION must be executed directly by orchestrator/runtime with zero subagents."
      }));
      return;
    }
    if (isWorkerRole(activeRole) || isReviewerRole(activeRole)) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "Hierarchy violation: Workers and Reviewers cannot spawn or coordinate subagents. All cross-worker coordination must route through Orchestrator."
      }));
      return;
    }

    if (toolName === "define_subagent") {
      const agentName = String(toolArgs.name || "").replace(/^["']|["']$/g, "").trim();
      if (!isValidAgentName(agentName)) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: `INVALID_AGENT_NAME: "${toolArgs.name || ""}" is not a valid agent name. Agent names must match /^[a-zA-Z0-9_-]+$/ and not contain path separators.`
        }));
        return;
      }

      const agentsDir = resolve(repoRoot, ".agents/agents");
      const agentFile = resolve(agentsDir, `${agentName}.md`);
      const isInside = agentFile.startsWith(agentsDir + sep) || agentFile.startsWith(agentsDir + "/");
      if (!isInside || !existsSync(agentFile)) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: `UNKNOWN_AGENT_PROFILE: Agent profile "${agentName}" does not exist in .agents/agents/. Only registered agent profiles may be defined.`
        }));
        return;
      }

      try {
        const rawContent = readFileSync(agentFile, "utf-8");
        const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        const authoritativePrompt = match ? match[2].trim() : rawContent.trim();
        console.log(JSON.stringify({
          decision: "allow",
          overwrite: {
            ...toolArgs,
            system_prompt: authoritativePrompt,
          },
        }));
        return;
      } catch (err) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: `AGENT_PROFILE_LOAD_FAILED: Could not load authoritative definition for "${agentName}": ${err.message}`
        }));
        return;
      }
    }

    if (toolName === "invoke_subagent") {
      const convId = payload.conversationId || "default";
      if (!roleBindings.mainConversationId) {
        roleBindings.mainConversationId = convId;
      }
      activeState.conversationId = roleBindings.mainConversationId || convId;
      activeState.activeRole = "ORCHESTRATOR";

      // Ensure orchestrator binding exists
      if (!roleBindings.bindings) roleBindings.bindings = {};
      if (!roleBindings.conversations) roleBindings.conversations = {};
      const orchRecord = {
        role: "ORCHESTRATOR",
        profile: "flash-orchestrator",
        model: payload.modelName || "gemini-3.8-flash-medium",
        source: "CONVERSATION_BOUND_IDENTITY",
      };
      roleBindings.bindings[convId] = orchRecord;
      roleBindings.conversations[convId] = orchRecord;

      if (!Array.isArray(roleBindings.pendingSubagents)) {
        roleBindings.pendingSubagents = [];
      }
      let subagents = Array.isArray(toolArgs.Subagents) ? toolArgs.Subagents : [];
      if (subagents.length === 0 && typeof toolArgs.Subagents === "string") {
        try {
          const parsed = JSON.parse(toolArgs.Subagents);
          if (Array.isArray(parsed)) subagents = parsed;
        } catch {}
      }

      // Check retry budget monotonicity using factual state only.
      // Never manufacture a retry attempt or remaining budget when the control-plane state is incomplete.
      if (activeState.retry || (activeState.attempt && activeState.attempt > 0) || activeState.retryReason || activeState.retry_reason) {
        const attempt = activeState.attempt;
        const prevRemaining = activeState.prevRemainingAttempts ?? activeState.remainingAttempts ?? activeState.retry_remaining;
        const currentRemaining = toolArgs.remainingAttempts ?? activeState.remainingAttempts ?? activeState.retry_remaining;

        if (!Number.isInteger(attempt) || attempt < 1) {
          console.log(JSON.stringify({
            decision: "deny",
            reason: "RETRY_STATE_UNRESOLVED: Retry execution requires a factual attempt >= 1.",
          }));
          return;
        }
        if (!Number.isInteger(prevRemaining) || !Number.isInteger(currentRemaining)) {
          console.log(JSON.stringify({
            decision: "deny",
            reason: "RETRY_BUDGET_UNRESOLVED: Retry execution requires factual previous and current remaining-attempt budgets.",
          }));
          return;
        }
        if (currentRemaining > prevRemaining) {
          console.log(JSON.stringify({
            decision: "deny",
            reason: `RETRY_BUDGET_VIOLATION: Retry budget cannot increase (attempted ${currentRemaining} > previous ${prevRemaining}).`,
          }));
          return;
        }
        if (prevRemaining <= 0 || currentRemaining <= 0) {
          console.log(JSON.stringify({
            decision: "deny",
            reason: "RETRY_BUDGET_EXHAUSTED: Maximum retries exceeded. No remaining retry budget.",
          }));
          return;
        }
      }

      const candidatePending = [];
      const decisionsToRecord = [];
      let seq = roleBindings.pendingSeq || 0;

      for (let idx = 0; idx < subagents.length; idx++) {
        seq++;
        const sub = subagents[idx];
        const typeName = sub.TypeName || sub.name || "";
        const roleStr = String(sub.Role || typeName).toLowerCase();
        const isReviewer = roleStr.includes("reviewer") || typeName === "flash-reviewer";
        const isInvestigator = roleStr === "investigator" || roleStr.includes("investig");
        const subRole = isReviewer ? "REVIEWER" : "WORKER";
        const delegationKind = isInvestigator ? "INVESTIGATION" : (isReviewer ? "REVIEW" : "WORK");
        let profile = typeName;
        if (!profile || profile.toLowerCase() === "worker") {
          const normModel = String(sub.Model || "").toLowerCase();
          if (normModel === "flash_lite" || normModel.includes("flash-low") || normModel === "low") {
            profile = "flash-low-worker";
          } else if (normModel === "flash" || normModel === "flash_medium" || normModel.includes("flash-medium") || normModel === "medium") {
            profile = "flash-medium-worker";
          } else if (normModel === "pro" || normModel === "high" || normModel.includes("flash-high")) {
            profile = "flash-worker";
          } else {
            profile = isReviewer ? "flash-reviewer" : (activeState.requested_agent || "flash-worker");
          }
        }
        let modelStr = sub.Model || null;
        if (!modelStr || modelStr === "inherit" || modelStr === "pro" || modelStr === "high") {
          if (isReviewer) {
            modelStr = "gemini-3.8-flash-high";
          } else if (profile === "flash-low-worker") {
            modelStr = "gemini-3.8-flash-low";
          } else if (profile === "flash-medium-worker") {
            modelStr = "gemini-3.8-flash-medium";
          } else {
            modelStr = "gemini-3.8-flash-high";
          }
        }

        const taskId = activeState.taskId || activeState.taskKey || process.env.BENCHMARK_TASK_ID || null;
        const benchmarkRunId = activeState.benchmarkRunId || process.env.BENCHMARK_RUN_ID || null;
        const toolCallId = toolCall.id || payload.toolCallId || null;

        candidatePending.push({
          seq,
          conversationId: null,
          parentConversationId: convId,
          typeName,
          profile,
          role: subRole,
          model: modelStr,
          taskIdentifier: taskId,
          benchmarkRunId,
          toolCallId,
          originToolCallId: toolCallId,
          originStepIdx: payload.stepIdx ?? null,
          delegationKind,
          creationOrder: idx,
          timestamp: new Date().toISOString(),
          consumed: false,
          consumedBy: null,
          consumedAt: null,
        });

        const rawProfile = sub.TypeName || sub.agent || sub.subagent_profile || sub.profile || "";
        const subRoleNormalized = String(sub.Role || sub.role || "").toLowerCase();
        const isDreamWorker = (
          subRoleNormalized === "worker" ||
          subRoleNormalized === "investigator" ||
          subRoleNormalized.includes("investig") ||
          activeState.complexity !== undefined
        ) && Boolean(
          PROFILE_TO_WORKER_ACTION[String(rawProfile).toLowerCase()] ||
          PROFILE_TO_WORKER_ACTION[String(sub.TypeName || "").toLowerCase()]
        );
        const isCritical = (activeState.criticality === "CRITICAL" || activeContract?.criticality === "CRITICAL");

        if (subagents.length === 1 && isDreamWorker && !isReviewer && !isDirectAction && !isCritical) {
          const isRetry = Boolean(activeState.retry || (activeState.attempt && activeState.attempt > 0) || activeState.retryReason || activeState.retry_reason);
          const rawReason = activeState.retryReason || activeState.retry_reason || null;
          const retryReason = typeof rawReason === "string" ? rawReason.trim().toUpperCase().replace(/[\s-]+/g, "_") : null;

          const facts = {
            taskAction: activeState.taskAction || "IMPLEMENT",
            taskDomain: activeState.taskDomain || "CODE",
            criticality: activeState.criticality || "NORMAL",
            complexity: activeState.complexity || "NORMAL",
            retry: isRetry,
            attempt: activeState.attempt || 0,
            remainingAttempts: activeState.remainingAttempts ?? activeState.retry_remaining ?? 0,
            retryReason,
            isDirectAction: false,
          };

          const taskSpec = activeState.taskSpec || activeState.taskDescription || activeState.prompt || "Worker delegation";
          const taskObj = {
            spec: taskSpec,
            task_action: facts.taskAction,
            task_domain: facts.taskDomain,
            criticality: facts.criticality,
          };

          const contractObj = activeContract || {
            allowed_paths: [],
            forbidden_paths: [".agents/**"],
            criticality: "NORMAL",
          };

          const runtimeObj = {
            node_version: process.version,
            platform: process.platform,
            arch: process.arch,
            schema_version: DREAM_SCHEMAS.SNAPSHOT,
          };

          const execStateObj = {
            step_sequence: payload.stepIdx ?? activeState.stepIdx ?? 0,
            attempt: facts.attempt,
            retry_remaining: activeState.retry_remaining ?? activeState.remainingAttempts ?? 0,
            mutation_seq: activeState.mutationSeq || activeState.mutation_seq || 0,
          };

          const evidenceObj = activeState.evidenceSummary || activeState.evidence || {
            tests: activeState.workerValidationVerified ? "PASS" : "UNKNOWN",
            typecheck: "UNKNOWN",
            build: "UNKNOWN",
            validation_fresh: Boolean(activeState.workerValidationFresh),
            scope_check: "UNKNOWN",
          };

          const snapRes = buildSnapshot({
            repoRoot,
            task: taskObj,
            contract: contractObj,
            runtime: runtimeObj,
            executionState: execStateObj,
            evidence: evidenceObj,
          });

          if (!snapRes.ok) {
            activeState.dreamRecordingError = snapRes.reason || "SNAPSHOT_BUILD_FAILED";
            try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
            continue;
          }

          const decisionState = deriveDecisionState(facts, activeState, evidenceObj);

          const hasPendingInvestigation = activeState.pendingPolicyRequirement?.selected_action === "INVESTIGATE_FIRST";
          const hasInvestigationInFlight = Boolean(activeState.investigationInFlight);

          if (hasPendingInvestigation || hasInvestigationInFlight) {
            const isInvestigationWorker =
              String(sub.Role || "").toLowerCase() === "investigator" ||
              String(sub.TypeName || "").toLowerCase().includes("investig") ||
              facts.taskAction === "INVESTIGATE" ||
              facts.action === "INVESTIGATE";

            if (!isInvestigationWorker) {
              console.log(JSON.stringify({
                decision: "deny",
                reason: hasInvestigationInFlight
                  ? "POLICY_MISMATCH: Investigation is currently in flight. Investigation completion required before worker execution."
                  : "POLICY_MISMATCH: Pending policy requirement INVESTIGATE_FIRST must be satisfied before implementation worker can be delegated.",
              }));
              return;
            } else {
              if (hasPendingInvestigation) {
                startPendingInvestigationRequirement({
                  activeState,
                  statePath,
                  repoRoot,
                  payload,
                  toolCall,
                  sub,
                  activeRole: actor.role || "ORCHESTRATOR",
                  activeContract,
                });
              }
              continue;
            }
          }

          // 1. Check INVESTIGATION_STRATEGY gate if this is a clean implementation
          if (
            decisionState.task_action === "IMPLEMENT" &&
            (decisionState.mutation_seq === 0 || decisionState.mutation_seq === undefined) &&
            !decisionState.post_investigation &&
            !isRetry
          ) {
            const invAvailable = deriveAvailableActions(DECISION_TYPES.INVESTIGATION_STRATEGY, decisionState);
            if (invAvailable.length > 0) {
              const invBaseline = deriveValidatedStaticBaseline({
                decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
                facts,
                state: decisionState,
              }) || "IMPLEMENT_DIRECT";
              const invEval = evaluatePolicyWithFallback({
                decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
                state: decisionState,
                availableActions: invAvailable,
                baselineAction: invBaseline,
              });
              if (invEval.action === "INVESTIGATE_FIRST") {
                activeState.pendingPolicyRequirement = {
                  decision_type: DECISION_TYPES.INVESTIGATION_STRATEGY,
                  selected_action: "INVESTIGATE_FIRST",
                  policy_source: invEval.source,
                  policy_id: invEval.policy_id,
                  baseline_action: invBaseline,
                  policy_diagnostic: invEval.policy_diagnostic,
                };
                try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
                console.log(JSON.stringify({
                  decision: "deny",
                  reason: "POLICY_MISMATCH: Investigation strategy requires INVESTIGATE_FIRST before implementation worker can be delegated.",
                }));
                return;
              }
            }
          }

          // 2. Determine decision type: RETRY_ACTION vs WORKER_TIER
          const decisionType = (isRetry && retryReason) ? DECISION_TYPES.RETRY_ACTION : DECISION_TYPES.WORKER_TIER;
          const availableActions = deriveAvailableActions(decisionType, decisionState);
          const baselineAction = deriveValidatedStaticBaseline({
            decisionType,
            facts,
            state: decisionState,
          }) || (decisionType === DECISION_TYPES.WORKER_TIER ? "FLASH_MEDIUM" : "RETRY_SAME");

          const evalResult = evaluatePolicyWithFallback({
            decisionType,
            state: decisionState,
            availableActions,
            baselineAction,
          });

          // 3. Real Online Policy Authority Enforcements
          if (decisionType === DECISION_TYPES.WORKER_TIER) {
            const expectedProfile = WORKER_ACTION_TO_PROFILE[evalResult.action];
            if (expectedProfile && profile !== expectedProfile) {
              console.log(JSON.stringify({
                decision: "deny",
                reason: `POLICY_MISMATCH: Policy selected ${evalResult.action} (${expectedProfile}) but requested subagent was "${profile}". Execution blocked.`,
              }));
              return;
            }
          } else if (decisionType === DECISION_TYPES.RETRY_ACTION) {
            if (evalResult.action === "INVESTIGATE_FIRST") {
              activeState.pendingPolicyRequirement = {
                decision_type: DECISION_TYPES.RETRY_ACTION,
                selected_action: "INVESTIGATE_FIRST",
                policy_source: evalResult.source,
                policy_id: evalResult.policy_id,
                baseline_action: baselineAction,
                policy_diagnostic: evalResult.policy_diagnostic,
              };
              try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
              console.log(JSON.stringify({
                decision: "deny",
                reason: `POLICY_MISMATCH: Retry policy selected INVESTIGATE_FIRST for retry reason "${retryReason}". Investigation required before worker execution.`,
              }));
              return;
            }
            if (evalResult.action === "REPLAN") {
              const currentState = activeState.state || "EXECUTING";
              const transitionCheck = validateStateTransition(currentState, "PLANNED", {
                retry: true,
                retry_reason: activeState.retryReason || activeState.retry_reason || retryReason,
              });

              if (!transitionCheck.valid) {
                activeState.state = "HUMAN_GATE";
                activeState.humanGateReason = `REPLAN_INVALID_STATE_TRANSITION: Transition from "${currentState}" to "PLANNED" rejected: ${transitionCheck.reason || "disallowed"}`;
                delete activeState.pendingPolicyRequirement;
                if (statePath) {
                  try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
                }
                console.log(JSON.stringify({
                  decision: "deny",
                  reason: `REPLAN_INVALID_TRANSITION: State transition from "${currentState}" to "PLANNED" rejected by governance: ${transitionCheck.reason || "disallowed"}. Routing to HUMAN_GATE.`,
                }));
                return;
              }

              // Pre-transition: record DECISION(REPLAN)
              const corrKey = dreamCorrelationKey({
                conversationId: convId,
                stepIdx: payload.stepIdx ?? 0,
                toolCallId: toolCall.id || payload.toolCallId || "",
                branchOrdinal: 0,
              });

              recordDecision({
                repoRoot,
                snapshot: snapRes.snapshot,
                decision: {
                  decision_type: DECISION_TYPES.RETRY_ACTION,
                  state: decisionState,
                  available_actions: availableActions.length > 0 ? availableActions : ["REPLAN"],
                  chosen_action: "REPLAN",
                  policy_source: evalResult.source || "STATIC_POLICY_V1",
                  policy_id: evalResult.policy_id || null,
                  baseline_action: baselineAction || "REPLAN",
                  policy_diagnostic: evalResult.policy_diagnostic || null,
                  actor_identity: activeRole || "ORCHESTRATOR",
                  conversation_id: convId,
                  step_idx: payload.stepIdx ?? 0,
                  tool_call_id: toolCall.id || payload.toolCallId || "",
                  branch_ordinal: 0,
                },
                correlationKey: corrKey,
              });

              // Execute deterministic state transition
              activeState.state = "PLANNED";
              delete activeState.pendingPolicyRequirement;
              if (statePath) {
                try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
              }

              console.log(JSON.stringify({
                decision: "deny",
                reason: `POLICY_MISMATCH: Retry policy selected REPLAN for retry reason "${retryReason}". State transitioned to PLANNED. Worker retry denied; replanning required.`,
              }));
              return;
            }
            if (evalResult.action === "ESCALATE_WORKER") {
              const profileTiers = { "flash-low-worker": 0, "flash-medium-worker": 1, "flash-worker": 2 };
              const lastProfile = activeState.lastWorkerProfile || null;
              if (!lastProfile || profileTiers[lastProfile] === undefined) {
                console.log(JSON.stringify({
                  decision: "deny",
                  reason: "RETRY_IDENTITY_UNRESOLVED: ESCALATE_WORKER requires a factual previous implementation worker profile.",
                }));
                return;
              }
              const lastTier = profileTiers[lastProfile];
              const currentTier = profileTiers[profile] ?? -1;
              if (currentTier <= lastTier || lastTier >= 2) {
                console.log(JSON.stringify({
                  decision: "deny",
                  reason: `POLICY_MISMATCH: Retry policy selected ESCALATE_WORKER for retry reason "${retryReason}" but requested "${profile}" after "${lastProfile}". Execution blocked.`,
                }));
                return;
              }
            }
            if (evalResult.action === "RETRY_SAME") {
              const lastProfile = activeState.lastWorkerProfile || null;
              if (!lastProfile) {
                console.log(JSON.stringify({
                  decision: "deny",
                  reason: "RETRY_IDENTITY_UNRESOLVED: RETRY_SAME requires a factual previous implementation worker profile.",
                }));
                return;
              }
              if (profile !== lastProfile) {
                console.log(JSON.stringify({
                  decision: "deny",
                  reason: `POLICY_MISMATCH: Retry policy selected RETRY_SAME for retry reason "${retryReason}" but requested worker "${profile}" does not match previous worker "${lastProfile}". Execution blocked.`,
                }));
                return;
              }
            }
          }

          const corrKey = dreamCorrelationKey({
            conversationId: convId,
            stepIdx: payload.stepIdx ?? 0,
            toolCallId: toolCall.id || payload.toolCallId || "",
            branchOrdinal: idx,
          });

          candidatePending[idx].decisionCorrelationKey = corrKey;
          candidatePending[idx].decisionType = decisionType;
          candidatePending[idx].decisionBranchOrdinal = idx;

          const decRecordInput = {
            decision_type: decisionType,
            state: decisionState,
            available_actions: availableActions,
            chosen_action: evalResult.action,
            policy_source: evalResult.source,
            policy_id: evalResult.policy_id,
            baseline_action: evalResult.baseline_action,
            policy_diagnostic: evalResult.policy_diagnostic,
            actor_identity: actor.role || "ORCHESTRATOR",
            conversation_id: convId,
            step_idx: payload.stepIdx ?? 0,
            tool_call_id: toolCall.id || payload.toolCallId || "",
            branch_ordinal: idx,
          };

          decisionsToRecord.push({
            snapshot: snapRes.snapshot,
            decision: decRecordInput,
            correlationKey: corrKey,
            profile,
          });
        }
      }

      // All subagents approved: commit state, bindings, and record decisions
      roleBindings.pendingSubagents.push(...candidatePending);
      roleBindings.pendingSeq = seq;
      saveRoleBindings(roleBindingsPath, roleBindings);

      // Auto-persist Scope Contract from invoke_subagent payload/prompt
      for (const sub of subagents) {
        const promptText = sub.Prompt || "";
        const extracted = extractScopeContractFromPrompt(promptText, sub);
        const allowedPaths = extracted.allowedPaths.length > 0
          ? extracted.allowedPaths
          : (activeContract?.allowedPaths || []);
        const testsRequired = extracted.testsRequired.length > 0
          ? extracted.testsRequired
          : (activeContract?.testsRequired || []);

        const contract = {
          contractId: activeContract?.contractId || `contract-${Date.now()}`,
          taskId: activeState.taskId || activeState.taskKey || null,
          targetAgent: sub.TypeName || (sub.Role && String(sub.Role).toLowerCase().includes("reviewer") ? "flash-reviewer" : "flash-low-worker"),
          allowedPaths,
          forbiddenPaths: extracted.forbiddenPaths.length > 0 ? extracted.forbiddenPaths : (activeContract?.forbiddenPaths || [".agents/**"]),
          testsRequired,
          createdAt: activeContract?.createdAt || new Date().toISOString(),
        };
        activeContract = contract;
        activeState.scopeContract = contract;
        try {
          mkdirSync(dirname(contractPath), { recursive: true });
          writeFileSync(contractPath, JSON.stringify(contract, null, 2), "utf-8");
        } catch {}
      }

      // Update state machine deterministically
      activeState.state = "DELEGATED";
      activeState.taskAction = activeState.taskAction || "IMPLEMENT";
      activeState.taskDomain = activeState.taskDomain || "CODE";
      activeState.handoffObserved = true;
      activeState.handoffStatus = "MESSAGE_DELIVERED";
      const implementationDelegations = candidatePending.filter((pending) => pending.delegationKind === "WORK");
      if (implementationDelegations.length > 0) {
        activeState.lastWorkerProfile = implementationDelegations[implementationDelegations.length - 1].profile;
      }
      try {
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
      } catch {}

      // Record factual decisions immediately pre-action
      for (const item of decisionsToRecord) {
        const decRes = recordDecision({
          repoRoot,
          snapshot: item.snapshot,
          decision: item.decision,
          correlationKey: item.correlationKey,
        });
        if (!decRes.recorded) {
          activeState.dreamRecordingError = decRes.reason || decRes.error_code || "DECISION_RECORD_FAILED";
          try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
        }
      }

      console.log(JSON.stringify({ decision: "allow" }));
      return;
    }
  }

  function allowCommand(commandToRun) {
    const runnerPath = resolve(repoRoot, ".agents/hooks/output-gate-runner.mjs");
    if (existsSync(runnerPath) && !commandToRun.includes("output-gate-runner.mjs")) {
      const executionId = `exec-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 9)}`;
      const stepIdx = payload.stepIdx ?? null;
      const conversationId = payload.conversationId || "default";
      const taskId = toolArgs.TaskId || toolArgs.taskId || null;
      const toolCallId = toolCall.id || payload.toolCallId || null;

      try {
        mkdirSync(pendingExecutionsDir, { recursive: true });
        const pendingKey = `${encodeURIComponent(conversationId)}__${stepIdx !== null ? stepIdx : executionId}`;
        const pendingFile = resolve(pendingExecutionsDir, `${pendingKey}.json`);
        writeFileSync(pendingFile, JSON.stringify({
          executionId,
          conversationId,
          stepIdx,
          taskId,
          toolCallId,
          agentId: activeRole,
          command: commandToRun,
          timestamp: new Date().toISOString(),
        }, null, 2), "utf-8");
      } catch {}

      const b64 = Buffer.from(commandToRun).toString("base64");
      console.log(JSON.stringify({
        decision: "allow",
        overwrite: {
          CommandLine: `node "${runnerPath}" --exec-id "${executionId}" --conv-id "${encodeURIComponent(conversationId)}" --step-idx "${stepIdx !== null ? stepIdx : ""}" --b64 ${b64}`
        }
      }));
      return;
    }
    console.log(JSON.stringify({ decision: "allow" }));
  }

  // Check 1a: schedule / timer policy during delegated execution
  if (toolName === "schedule") {
    if (isHealthyDelegatedExecution(activeState, activeRole)) {
      const reason = "Reactive Wakeup policy: Routine schedule/timer calls are prohibited for Orchestrator during healthy delegated execution. TERMINAL DELEGATION PROTOCOL: Yield immediately with ZERO tools. Do NOT call schedule, timers, or polls; Antigravity will automatically wake you upon child completion.";
      recordDeniedAttempt(activeState, statePath, "schedule", toolArgs, reason);
      console.log(JSON.stringify({
        decision: "deny",
        reason,
      }));
      return;
    }
    console.log(JSON.stringify({ decision: "allow" }));
    return;
  }

  // Check 1b: manage_task polling budget and delegation lock
  if (toolName === "manage_task") {
    const action = String(toolArgs.Action || toolArgs.action || "");
    const isCancellation = action === "kill";
    if (isCancellation) {
      console.log(JSON.stringify({ decision: "allow" }));
      return;
    }

    if (action === "status") {
      if (isHealthyDelegatedExecution(activeState, activeRole)) {
        const reason = "Reactive Wakeup policy: Routine manage_task status polling is prohibited for Orchestrator during healthy delegated execution (polling budget is closed). Yield and await asynchronous reactive wakeup on child completion.";
        recordDeniedAttempt(activeState, statePath, "manage_task", toolArgs, reason);
        console.log(JSON.stringify({
          decision: "deny",
          reason,
        }));
        return;
      }

      const tracker = activeState.pollingTracker || {};
      const now = Date.now();
      const budget = checkPollingBudget(tracker, now);
      if (!budget.allowed) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: budget.message,
        }));
        return;
      }
      activeState.pollingTracker = {
        taskId: toolArgs.TaskId || toolArgs.taskId || null,
        pollCount: budget.pollCount,
        lastPollTimestamp: budget.lastPollTimestamp,
      };
      try {
        writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
      } catch {}
    }
    console.log(JSON.stringify({ decision: "allow" }));
    return;
  }

  // Check 1c: manage_subagents polling policy
  if (toolName === "manage_subagents") {
    const action = String(toolArgs.Action || toolArgs.action || "list").toLowerCase();
    const isCancellation = action === "kill" || action === "kill_all";
    const isDiagnosedStalled = Boolean(activeState.stalled || activeState.circuitBreakerType === "STALLED");
    const isCircuitBreakerRecovery = Boolean(activeState.circuitBreakerTripped || activeState.circuitBreaker);
    const isExplicitUserStatus = Boolean(activeState.userRequestedStatus);
    const isRecoveryWithoutReactive = Boolean(activeState.reactiveWakeupDisabled);

    if (isCancellation || isDiagnosedStalled || isCircuitBreakerRecovery || isExplicitUserStatus || isRecoveryWithoutReactive) {
      console.log(JSON.stringify({ decision: "allow" }));
      return;
    }

    const reason = "Reactive Wakeup policy: Routine manage_subagents polling is prohibited during healthy delegated execution. Await asynchronous reactive wakeup on child completion.";
    recordDeniedAttempt(activeState, statePath, "manage_subagents", toolArgs, reason);
    console.log(JSON.stringify({
      decision: "deny",
      reason,
    }));
    return;
  }

  // Check 1d: view_file, grep_search, find_by_name inspection lock during delegation
  if (toolName === "view_file" || toolName === "grep_search" || toolName === "find_by_name") {
    const currentState = String(activeState.state || "").toUpperCase();
    if (isOrchestratorRole(activeRole) && currentState === "DELEGATED") {
      const reason = `Reactive Wakeup policy: Orchestrator exploration/inspection (${toolName}) is prohibited during delegated execution. Workers own implementation discovery and exploration; Orchestrator must yield and await child completion.`;
      recordDeniedAttempt(activeState, statePath, toolName, toolArgs, reason);
      console.log(JSON.stringify({
        decision: "deny",
        reason,
      }));
      return;
    }
    console.log(JSON.stringify({ decision: "allow" }));
    return;
  }

  // Check 2: run_command enforcement
  if (toolName === "run_command") {
    const cmd = String(toolArgs.CommandLine || toolArgs.command || toolArgs.cmd || "");

    // 2a. Reviewer: strictly read-only, prohibited from executing shell commands
    if (isReviewerRole(activeRole)) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "Separation of duties violation: Reviewer is strictly read-only and is prohibited from executing shell commands."
      }));
      return;
    }

    // Large File Guard check
    const largeFileCheck = checkLargeFileGuard(cmd, repoRoot);
    if (largeFileCheck.blocked) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: largeFileCheck.reason
      }));
      return;
    }

    const isReadOnly = isReadOnlyCommand(cmd);
    const isValidation = isValidationCommand(cmd);
    const targets = extractTargetPaths(cmd, repoRoot);
    const redir = extractRealShellRedirections(cmd);

    const nonControlTargets = targets.filter(t => !isControlPlanePath(t));
    const nonControlRedir = redir.targets.filter(t => !isControlPlanePath(t));
    const hasWorkspaceMutationTargets = nonControlTargets.length > 0 || nonControlRedir.length > 0;

    // Unknown role: read-only/validation without workspace redirections is safe; mutating commands fail closed!
    if (!activeRole || activeRole === "UNKNOWN") {
      if ((isReadOnly || isValidation) && !hasWorkspaceMutationTargets && redir.targets.length === 0 && targets.length === 0) {
        allowCommand(cmd);
        return;
      }
      console.log(JSON.stringify({
        decision: "deny",
        reason: "ROLE_IDENTITY_UNRESOLVED: Actor identity could not be verified by runtime evidence. Workspace mutations are prohibited for unresolved roles."
      }));
      return;
    }

    // 2b. Orchestrator: allow read-only and validation; block shell mutations to workspace/product code
    if (isOrchestratorRole(activeRole)) {
      if (isHealthyDelegatedExecution(activeState, activeRole)) {
        const reason = "Reactive Wakeup policy: Orchestrator command execution is prohibited during healthy delegated execution. Workers own implementation and validation; Orchestrator must yield and await child completion.";
        recordDeniedAttempt(activeState, statePath, "run_command", toolArgs, reason);
        console.log(JSON.stringify({
          decision: "deny",
          reason,
        }));
        return;
      }

      if (isReadOnly || isValidation) {
        if (hasWorkspaceMutationTargets) {
          const badTarget = nonControlTargets[0] || nonControlRedir[0];
          console.log(JSON.stringify({
            decision: "deny",
            reason: `ORCHESTRATOR_WORKSPACE_WRITE_PROHIBITED: Separation of duties violation: Orchestrator is forbidden from redirecting output to product code or workspace files ("${badTarget}"). Delegate implementation to Gemini Flash.`
          }));
          return;
        }
        allowCommand(cmd);
        return;
      }

      // Explicit DIRECT_ACTION mode permits direct operational commands
      if (isDirectAction) {
        if (hasWorkspaceMutationTargets) {
          const badTarget = nonControlTargets[0] || nonControlRedir[0];
          console.log(JSON.stringify({
            decision: "deny",
            reason: `DIRECT_ACTION_SIDE_QUEST: Separation of duties violation: Direct Action is forbidden from modifying product code or workspace files ("${badTarget}").`
          }));
          return;
        }
        if (/\b(sed\s+-[a-zA-Z]*i|rm\s+|mv\s+|cp\s+|touch\s+|truncate\s+|tee\s+)\b/.test(cmd)) {
          console.log(JSON.stringify({
            decision: "deny",
            reason: `DIRECT_ACTION_SIDE_QUEST: Modifying workspace files via destructive commands is prohibited during DIRECT_ACTION.`
          }));
          return;
        }
        allowCommand(cmd);
        return;
      }

      // Mutating command by Orchestrator targeting workspace files
      if (hasWorkspaceMutationTargets) {
        const badTarget = nonControlTargets[0] || nonControlRedir[0];
        console.log(JSON.stringify({
          decision: "deny",
          reason: `ORCHESTRATOR_WORKSPACE_WRITE_PROHIBITED: Separation of duties violation: Orchestrator is forbidden from modifying product code or workspace files ("${badTarget}") via shell commands. Delegate implementation to Gemini Flash.`
        }));
        return;
      }

      if (/\b(sed\s+-[a-zA-Z]*i|rm\s+|mv\s+|cp\s+|touch\s+|truncate\s+|tee\s+)\b/.test(cmd)) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: `ORCHESTRATOR_WORKSPACE_WRITE_PROHIBITED: Separation of duties violation: Orchestrator is forbidden from modifying product code or workspace files via shell commands. Delegate implementation to Gemini Flash.`
        }));
        return;
      }

      const allControlPlane = (targets.length > 0 || redir.targets.length > 0) &&
        targets.every(isControlPlanePath) && redir.targets.every(isControlPlanePath);
      if (allControlPlane) {
        allowCommand(cmd);
        return;
      }

      console.log(JSON.stringify({
        decision: "deny",
        reason: `ORCHESTRATOR_UNVERIFIED_COMMAND_PROHIBITED: Separation of duties violation: Orchestrator cannot run unverified or arbitrary shell commands ("${cmd}") whose side effects cannot be proven safe. Normal orchestration permits only known read-only commands, known validation commands, and verified control-plane operations. Delegate implementation to Gemini Flash.`
      }));
      return;
    }

    // 2c. Worker (Flash): validate mutating commands against Scope Contract
    if (isWorkerRole(activeRole)) {
      if (isReadOnly) {
        allowCommand(cmd);
        return;
      }

      if (isValidation) {
        const valLock = checkValidationCompletionLock({
          activeState,
          activeContract,
          activeRole,
          commandLine: cmd,
        });
        if (valLock.locked) {
          recordDeniedAttempt(activeState, statePath, "run_command", toolArgs, valLock.reason);
          console.log(JSON.stringify({
            decision: "deny",
            reason: valLock.reason,
          }));
          return;
        }
        allowCommand(cmd);
        return;
      }


      if (activeContract) {
        const allowed = Array.isArray(activeContract.allowedPaths) ? activeContract.allowedPaths : [];
        const forbidden = Array.isArray(activeContract.forbiddenPaths) ? activeContract.forbiddenPaths : [];

        // Check forbiddenPaths
        for (const t of targets) {
          for (const pattern of forbidden) {
            if (pathMatchesPattern(t, pattern)) {
              console.log(JSON.stringify({
                decision: "deny",
                reason: `Scope contract violation: shell command targets forbidden path "${t}" matching "${pattern}".`
              }));
              return;
            }
          }
        }

        // Check allowedPaths
        if (allowed.length > 0) {
          for (const t of targets) {
            const isAllowed = allowed.some((pattern) => pathMatchesPattern(t, pattern));
            if (!isAllowed) {
              console.log(JSON.stringify({
                decision: "deny",
                reason: `Scope contract violation: shell command targets path "${t}" outside allowedPaths [${allowed.join(", ")}]. If required, return CROSS_DOMAIN_REQUEST to Orchestrator.`
              }));
              return;
            }
          }
        }

        // Fallback check on forbidden keywords in command string
        for (const pattern of forbidden) {
          const rawPatternPrefix = pattern.replace(/\/\*\*?$/, "");
          if (cmd.includes(rawPatternPrefix) && (/\b(rm|sed\s+-[a-zA-Z]*i|mv|cp|touch)\b/.test(cmd) || redir.targets.some(t => t.includes(rawPatternPrefix)))) {
            console.log(JSON.stringify({
              decision: "deny",
              reason: `Scope contract violation: shell command references forbidden path "${rawPatternPrefix}".`
            }));
            return;
          }
        }

        // Anti-obfuscation check: if decoding used to target files, scope must be respected
        if (/\b(base64\s+(?:-[a-zA-Z]*d|--decode)|xxd\s+-r)\b/.test(cmd)) {
          for (const t of targets) {
            const isAllowed = allowed.some((pattern) => pathMatchesPattern(t, pattern));
            if (!isAllowed) {
              console.log(JSON.stringify({
                decision: "deny",
                reason: `Scope contract violation: encoded write targets path "${t}" outside allowedPaths. Reformulate using supported safe mechanism within authorized scope.`
              }));
              return;
            }
          }
        }
      }

      allowCommand(cmd);
      return;
    }

    allowCommand(cmd);
    return;
  }

  // Check 3: write_to_file and replace_file_content
  if (toolName === "write_to_file" || toolName === "replace_file_content") {
    const rawTarget = toolArgs.TargetFile || toolArgs.targetFile || toolArgs.path || "";
    const relTarget = normalizePath(rawTarget.startsWith(repoRoot) ? relative(repoRoot, rawTarget) : rawTarget);

    // 0. Constitution protection: AGENTS.md is strictly immutable across all agents
    if (relTarget === "AGENTS.md" || relTarget.endsWith("/AGENTS.md")) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "AGENTS.md is the provider-neutral repository constitution and is strictly read-only for all agents."
      }));
      return;
    }

    // 1. Reviewer: strictly read-only across all files (including control plane)
    if (isReviewerRole(activeRole)) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: `Separation of duties violation: Reviewer is strictly read-only and is forbidden from modifying files (${relTarget}). Report findings to Orchestrator.`
      }));
      return;
    }

    // 2. UNKNOWN: deny ANY mutation (including control-plane!)
    if (!activeRole || activeRole === "UNKNOWN") {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "ROLE_IDENTITY_UNRESOLVED: Actor identity could not be verified by runtime evidence. Workspace mutations are prohibited for unresolved roles."
      }));
      return;
    }

    const isControlPlane = isControlPlanePath(relTarget);

    // 3. Target is a non-control-plane workspace file: check DIRECT_ACTION
    if (!isControlPlane && isDirectAction) {
      if (!activeState.toolMix) activeState.toolMix = {};
      activeState.toolMix.direct_action_side_quests_prevented = (activeState.toolMix.direct_action_side_quests_prevented || 0) + 1;
      try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
      console.log(JSON.stringify({
        decision: "deny",
        reason: `DIRECT_ACTION_SIDE_QUEST: Modifying files ("${relTarget}") during DIRECT_ACTION is strictly prohibited by Exact Intent Boundary. Report blockers instead of performing side quests.`
      }));
      return;
    }

    // 4. Orchestrator: only control-plane allowed; product code / workspace writes prohibited
    if (isOrchestratorRole(activeRole)) {
      if (isControlPlane) {
        console.log(JSON.stringify({ decision: "allow" }));
        return;
      }
      console.log(JSON.stringify({
        decision: "deny",
        reason: `ORCHESTRATOR_WORKSPACE_WRITE_PROHIBITED: Separation of duties violation: Orchestrator is forbidden from directly writing product code or workspace files ("${relTarget}"). Orchestrator writes are denied by default except for control-plane paths. Delegate implementation to Gemini Flash.`
      }));
      return;
    }

    // Worker validation against Scope Contract
    if (isWorkerRole(activeRole)) {
      if (!activeContract) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: `SCOPE_VIOLATION: Worker cannot modify workspace files ("${relTarget}") without an active Scope Contract.`
        }));
        return;
      }

      const allowed = Array.isArray(activeContract.allowedPaths) ? activeContract.allowedPaths : [];
      const forbidden = Array.isArray(activeContract.forbiddenPaths) ? activeContract.forbiddenPaths : [];

      for (const pattern of forbidden) {
        if (pathMatchesPattern(relTarget, pattern)) {
          console.log(JSON.stringify({
            decision: "deny",
            reason: `SCOPE_VIOLATION: "${relTarget}" matches forbiddenPaths pattern "${pattern}".`
          }));
          return;
        }
      }

      if (allowed.length === 0) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: `SCOPE_VIOLATION: Worker has no allowedPaths specified in active Scope Contract.`
        }));
        return;
      }

      const isAllowed = allowed.some((pattern) => pathMatchesPattern(relTarget, pattern));
      if (!isAllowed) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: `SCOPE_VIOLATION: "${relTarget}" is outside allowedPaths [${allowed.join(", ")}]. If required, return CROSS_DOMAIN_REQUEST to Orchestrator.`
        }));
        return;
      }

      // Check INVESTIGATION_STRATEGY before first mutation of eligible implementation
      if (
        !isControlPlane &&
        (activeState.taskAction === "IMPLEMENT" || !activeState.taskAction) &&
        (!activeState.mutationSeq || activeState.mutationSeq === 0) &&
        !activeState.postInvestigation &&
        !isDirectAction
      ) {
        const facts = {
          taskAction: activeState.taskAction || "IMPLEMENT",
          taskDomain: activeState.taskDomain || "CODE",
          criticality: activeState.criticality || "NORMAL",
          complexity: activeState.complexity || "NORMAL",
          postInvestigation: false,
          isDirectAction: false,
        };
        const invState = deriveDecisionState(facts, activeState);
        const invAvailable = deriveAvailableActions(DECISION_TYPES.INVESTIGATION_STRATEGY, invState);
        if (invAvailable.length > 0) {
          const invBaseline = deriveValidatedStaticBaseline({
            decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
            facts,
            state: invState,
          }) || "IMPLEMENT_DIRECT";
          const invRes = evaluatePolicyWithFallback({
            decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
            state: invState,
            availableActions: invAvailable,
            baselineAction: invBaseline,
          });
          if (invRes.action === "INVESTIGATE_FIRST") {
            console.log(JSON.stringify({
              decision: "deny",
              reason: "INVESTIGATION_REQUIRED: Investigation strategy policy requires INVESTIGATE_FIRST before implementation mutations can execute.",
            }));
            return;
          }
          if (invRes.action === "IMPLEMENT_DIRECT" && !activeState.investigationStrategyEvaluated) {
            const taskObj = {
              spec: activeState.taskSpec || "Implementation mutation",
              task_action: facts.taskAction,
              task_domain: facts.taskDomain,
              criticality: facts.criticality,
            };
            const snapRes = buildSnapshot({
              repoRoot,
              task: taskObj,
              contract: activeContract || { allowed_paths: [], forbidden_paths: [".agents/**"], criticality: "NORMAL" },
              runtime: { node_version: process.version, platform: process.platform, arch: process.arch, schema_version: DREAM_SCHEMAS.SNAPSHOT },
              executionState: { step_sequence: payload.stepIdx ?? 0, attempt: activeState.attempt || 0, retry_remaining: activeState.retry_remaining ?? 0, mutation_seq: 0 },
              evidence: activeState.evidenceSummary || activeState.evidence || { tests: "UNKNOWN", typecheck: "UNKNOWN", build: "UNKNOWN", validation_fresh: false, scope_check: "UNKNOWN" },
            });
            if (snapRes.ok) {
              const corrKey = dreamCorrelationKey({
                conversationId: payload.conversationId || activeState.conversationId || "default",
                stepIdx: payload.stepIdx ?? 0,
                toolCallId: toolCall.id || payload.toolCallId || "",
                branchOrdinal: 0,
              });
              const directDecision = recordDecision({
                repoRoot,
                snapshot: snapRes.snapshot,
                decision: {
                  decision_type: DECISION_TYPES.INVESTIGATION_STRATEGY,
                  state: invState,
                  available_actions: invAvailable,
                  chosen_action: "IMPLEMENT_DIRECT",
                  policy_source: invRes.source,
                  policy_id: invRes.policy_id,
                  baseline_action: invRes.baseline_action,
                  policy_diagnostic: invRes.policy_diagnostic,
                  actor_identity: activeRole || "WORKER",
                  conversation_id: payload.conversationId || activeState.conversationId || "default",
                  step_idx: payload.stepIdx ?? 0,
                  tool_call_id: toolCall.id || payload.toolCallId || "",
                  branch_ordinal: 0,
                },
                correlationKey: corrKey,
              });
              if (directDecision.recorded) {
                activeState.directInvestigationDecisionInFlight = {
                  correlationKey: corrKey,
                  childConversationId: payload.conversationId || null,
                  originToolCallId: toolCall.id || payload.toolCallId || null,
                  decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
                  chosenAction: "IMPLEMENT_DIRECT",
                  startedAt: new Date().toISOString(),
                };
              } else {
                activeState.dreamRecordingError = directDecision.reason || directDecision.error_code || "DIRECT_INVESTIGATION_DECISION_RECORD_FAILED";
              }
            }
            activeState.investigationStrategyEvaluated = true;
            try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
          }
        }
      }

      console.log(JSON.stringify({ decision: "allow" }));
      return;
    }

    console.log(JSON.stringify({
      decision: "deny",
      reason: `ROLE_IDENTITY_UNRESOLVED: Unauthorized role "${activeRole}" cannot modify workspace files.`
    }));
    return;
  }

  console.log(JSON.stringify({ decision: "allow" }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
