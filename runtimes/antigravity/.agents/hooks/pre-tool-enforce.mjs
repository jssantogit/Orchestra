import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, relative, dirname, basename, sep, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  extractRealShellRedirections,
  TOOL_OUTPUT_LIMITS,
  POLLING_POLICY,
  checkPollingBudget,
  isControlPlanePath,
  classifyScopeSpecificity,
  isConcretePath,
  classifyShellMutation,
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
import { loadRuntimePolicy } from "../dream/policy-store.mjs";
import {
  captureBranchSeedIfArmed,
  consumeExplorationTarget,
  resolveExplorationPolicyOverlay,
} from "../dream/exploration-lab.mjs";
import {
  evaluateCanaryPolicyOverlay,
  isCanaryExternalSideEffect,
  rollbackSelectedCanaryTask,
} from "../dream/canary-mode.mjs";
import {
  factualSubagentMatchesPending,
  filterFactualPendingCandidates,
  findFactualSubagentRecord,
  isSymmetricReviewerSet,
} from "./child-identity.mjs";

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

function loadActivePolicy(repoRoot) {
  const loaded = loadRuntimePolicy(repoRoot);
  if (!loaded.ok) {
    return {
      policy: null,
      diagnostic: loaded.reason || "INVALID_POLICY",
      source: "STATIC_ROUTING_FALLBACK",
    };
  }
  return {
    policy: loaded.policy,
    diagnostic: loaded.diagnostic || null,
    source: loaded.source || "STATIC_POLICY_V1",
  };
}

function evaluatePolicyWithFallback({
  repoRoot,
  decisionType,
  state,
  availableActions,
  baselineAction,
  activeState = {},
  activeContract = {},
  taskId = null,
}) {
  const safeBaseline = typeof baselineAction === "string" ? baselineAction : "";
  const exploration = resolveExplorationPolicyOverlay({
    repoRoot,
    decisionType,
    state,
    availableActions,
    baselineAction: safeBaseline,
  });
  if (exploration?.active) {
    if (exploration.blocked) {
      return {
        ok: false,
        action: "",
        source: "EXPLORATION_LAB",
        policy_id: null,
        baseline_action: safeBaseline,
        policy_diagnostic: exploration.reason,
        block_execution: true,
      };
    }
    return exploration;
  }

  const loaded = loadActivePolicy(repoRoot);
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

    let staticResult;
    if (evalRes.ok) {
      staticResult = {
        ok: true,
        action: evalRes.action,
        source: loaded.source === "ACTIVE_POLICY" ? "ACTIVE_POLICY" : "STATIC_POLICY_V1",
        policy_id: evalRes.policy_id,
        baseline_action: safeBaseline,
        policy_diagnostic: null,
      };
    } else {
      let diag = "INTERPRETER_EXCEPTION";
      if (evalRes.diagnostic?.includes("POLICY_CONFLICT")) diag = "POLICY_CONFLICT";
      else if (evalRes.diagnostic?.includes("POLICY_INVALID_ACTION")) diag = "POLICY_INVALID_ACTION";
      else if (evalRes.diagnostic?.includes("NO_MATCHING_RULE")) diag = "NO_MATCHING_RULE";
      else if (evalRes.diagnostic?.includes("INVALID_POLICY")) diag = "INVALID_POLICY";
      staticResult = {
        ok: false,
        action: evalRes.action || safeBaseline,
        source: "STATIC_ROUTING_FALLBACK",
        policy_id: evalRes.policy_id || loaded.policy?.policy_id || null,
        baseline_action: safeBaseline,
        policy_diagnostic: diag,
      };
    }

    // Canary may only overlay a healthy current baseline. Any Canary failure
    // rolls the session back internally and this exact decision remains static.
    if (staticResult.ok) {
      const canary = evaluateCanaryPolicyOverlay({
        repoRoot,
        taskId,
        decisionType,
        state,
        availableActions,
        baselineAction: staticResult.action,
        baselinePolicyId: loaded.policy.policy_id,
        activeState,
        activeContract,
      });
      if (canary?.active) {
        return {
          ok: true,
          action: canary.action,
          source: canary.source,
          policy_id: canary.policy_id,
          baseline_action: staticResult.action,
          policy_diagnostic: canary.policy_diagnostic || null,
          canary_session_id: canary.canary_session_id,
          canary_bucket: canary.canary_bucket,
        };
      }
    }

    return staticResult;
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
    const effectiveActions = availableActions.length > 0 ? availableActions : ["IMPLEMENT_DIRECT", "INVESTIGATE_FIRST"];
    const seedCapture = captureBranchSeedIfArmed({
      repoRoot,
      snapshot: snapRes.snapshot,
      decisionType: req.decision_type || DECISION_TYPES.INVESTIGATION_STRATEGY,
      decisionState: decState,
      availableActions: effectiveActions,
      scopeContract: activeContract || { allowed_paths: [], forbidden_paths: [".agents/**"], criticality: "NORMAL" },
      taskDescriptor: taskObj,
      evidenceSummary: activeState.evidenceSummary || activeState.evidence || {},
      runtimeState: activeState,
    });
    if (seedCapture.captured) {
      activeState.explorationSeedCaptured = seedCapture.seed_id;
    }
    recordDecision({
      repoRoot,
      snapshot: req.source_snapshot_id || snapRes.snapshot,
      decision: {
        decision_type: req.decision_type || DECISION_TYPES.INVESTIGATION_STRATEGY,
        state: decState,
        available_actions: effectiveActions,
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
    consumeExplorationTarget({
      repoRoot,
      decisionType: req.decision_type || DECISION_TYPES.INVESTIGATION_STRATEGY,
      state: decState,
      action: "INVESTIGATE_FIRST",
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

function canonicalizeWorkspaceTarget(rawTarget, repoRoot) {
  const raw = String(rawTarget || "").trim().replace(/^["']|["']$/g, "");
  const lexicalAbsolutePath = resolve(repoRoot, raw);

  let physicalRepoRoot = resolve(repoRoot);
  try { physicalRepoRoot = realpathSync(repoRoot); } catch {}

  // Resolve symlinks in the deepest existing ancestor, then append any
  // non-existing suffix. This protects create_file/write_to_file targets too.
  let ancestor = lexicalAbsolutePath;
  const suffix = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }

  let physicalAncestor = ancestor;
  try {
    if (existsSync(ancestor)) physicalAncestor = realpathSync(ancestor);
  } catch {}

  const physicalAbsolutePath = suffix.length > 0
    ? resolve(physicalAncestor, ...suffix)
    : physicalAncestor;
  const rel = relative(physicalRepoRoot, physicalAbsolutePath);
  const outsideWorkspace = Boolean(
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  );

  return {
    path: normalizePath(rel),
    absolutePath: physicalAbsolutePath,
    lexicalAbsolutePath,
    outsideWorkspace,
  };
}

function isWorkspaceEscapePath(relPath) {
  const norm = normalizePath(relPath);
  return norm === ".." || norm.startsWith("../") || /^[A-Za-z]:\//.test(norm);
}

function isAgentControlPlanePath(relPath) {
  const norm = normalizePath(relPath);
  return norm === ".agents" || norm.startsWith(".agents/");
}

function isOrchestratorScratchPath(relPath) {
  const norm = normalizePath(relPath);
  return norm === "scratch" ||
    norm.startsWith("scratch/") ||
    norm === ".scratch" ||
    norm.startsWith(".scratch/");
}

function isRepositoryConstitutionPath(relPath) {
  const norm = normalizePath(relPath);
  return norm === "AGENTS.md" || norm.endsWith("/AGENTS.md");
}

function readGitHead(repoRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function isReviewerSubagentDescriptor(sub = {}) {
  const typeName = String(sub.TypeName || sub.name || "");
  const roleStr = String(sub.Role || sub.role || typeName).toLowerCase();
  return roleStr.includes("reviewer") || typeName === "flash-reviewer";
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

function readGovernanceObject(path, label) {
  if (!existsSync(path)) {
    return { ok: true, exists: false, value: null };
  }
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

function validateRoleBindingsShape(roleBindings) {
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
  if (!loaded.exists) {
    return { mainConversationId: null, bindings: {}, pendingSubagents: [] };
  }
  if (!validateRoleBindingsShape(loaded.value)) {
    return {
      mainConversationId: null,
      bindings: {},
      pendingSubagents: [],
      __governanceLoadError: "ROLE_BINDINGS_INVALID_SHAPE",
    };
  }
  return loaded.value;
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

  if (convId) {
    const existing = (roleBindings.bindings && roleBindings.bindings[convId])
      || (roleBindings.conversations && roleBindings.conversations[convId]);

    if (existing) {
      // Provisional hook correlation may later be upgraded by the factual Antigravity
      // brain record for this exact child conversation.
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

        // Preferred path: exact child conversation found in Antigravity's factual
        // parent brain metadata, then correlated to a pending delegation.
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
            // Two-Key reviewer slots are intentionally symmetric: either factual
            // reviewer child may occupy either identical read-only slot.
            matched = factualCandidates.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0];
            slotAssignment = "SYMMETRIC_REVIEW_SLOT";
          }
          if (matched) {
            source = "RUNTIME_IDENTITY";
            confidence = "HIGH";
          }
        }

        // Fallback for early child hooks before brain metadata is durable.
        // This may authorize the correlated role, but it is explicitly provisional
        // and can never satisfy factual completion gates.
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
      const expectedMainConversationId = roleBindings.mainConversationId || activeState.conversationId || null;
      const hasPendingDelegations = Array.isArray(roleBindings.pendingSubagents)
        && roleBindings.pendingSubagents.some((p) => !p?.consumed);

      if (
        convId &&
        (
          (expectedMainConversationId && convId !== expectedMainConversationId) ||
          (!expectedMainConversationId && hasPendingDelegations)
        )
      ) {
        return {
          role: "UNKNOWN",
          source: "UNRESOLVED",
          confidence: "LOW",
          actorId: convId,
        };
      }

      if (convId && !roleBindings.mainConversationId && !hasPendingDelegations) {
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
        if (roleBindingsPath) saveRoleBindings(roleBindingsPath, roleBindings);
        return {
          role: "ORCHESTRATOR",
          source: "RUNTIME_BOOTSTRAP",
          confidence: "HIGH",
          actorId: convId,
          agentProfile: "flash-orchestrator",
          model: orchRecord.model,
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

  // 3. rm, mv, cp, touch, truncate, mkdir
  const fileOpRegex = /\b(rm|mv|cp|touch|truncate|mkdir)\s+([^;&|]+)/g;
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

  // Canonicalize lexical targets relative to repoRoot before scope checks.
  // This collapses "." / ".." so "src/../.agents/x" cannot masquerade as src/**.
  const result = [];
  for (const t of targets) {
    const canonical = canonicalizeWorkspaceTarget(t, repoRoot);
    const normalized = canonical.outsideWorkspace
      ? normalizePath(relative(repoRoot, canonical.absolutePath))
      : canonical.path;
    result.push(normalized);
  }
  return result;
}


function isReadOnlyCommand(cmd) {
  const trimmed = cmd.trim();
  const redir = extractRealShellRedirections(cmd);
  if (redir.targets.length > 0) return false;

  // Prefix whitelisting is only sound for a single simple command. Shell
  // composition/substitution can execute arbitrary side effects behind an
  // otherwise read-only-looking prefix.
  if (/[;|&`]/.test(trimmed) || /\$\(/.test(trimmed) || /[\r\n]/.test(trimmed)) {
    return false;
  }

  if (/\b(sed\s+-[a-zA-Z]*i|rm\s+|mv\s+|cp\s+|touch\s+|truncate\s+|tee\s+|writeFileSync|open\(.+["'][wa])\b/.test(cmd)) {
    return false;
  }

  // Git read commands with --output write files; git branch is mutating for
  // creation/deletion/rename and therefore is not generically read-only.
  if (/^git\s+(?:diff|log|show|grep|status|rev-parse)\b.*(?:^|\s)--output(?:=|\s)/.test(trimmed)) {
    return false;
  }

  // find becomes mutating as soon as action forms are present.
  if (/^find\b/.test(trimmed) && /(?:^|\s)-(?:delete|exec|execdir|ok|okdir)(?:\s|$)/.test(trimmed)) {
    return false;
  }

  return (
    trimmed.startsWith("git diff") ||
    trimmed.startsWith("git status") ||
    trimmed.startsWith("git log") ||
    trimmed.startsWith("git show") ||
    trimmed.startsWith("git grep") ||
    trimmed.startsWith("git rev-parse") ||
    trimmed === "ls" || trimmed.startsWith("ls ") ||
    trimmed.startsWith("cat ") ||
    trimmed.startsWith("head ") ||
    trimmed.startsWith("tail ") ||
    trimmed.startsWith("grep ") ||
    trimmed.startsWith("rg ") ||
    trimmed.startsWith("find ") ||
    trimmed.startsWith("which ") ||
    trimmed.startsWith("whereis ") ||
    trimmed === "pwd" ||
    trimmed.startsWith("echo ") ||
    trimmed.startsWith("printf ") ||
    trimmed.startsWith("wc ") ||
    trimmed.startsWith("stat ") ||
    trimmed.startsWith("file ") ||
    trimmed.startsWith("du ") ||
    trimmed.startsWith("df ") ||
    trimmed === "node -v" ||
    trimmed === "node --version" ||
    trimmed === "npm -v" ||
    trimmed === "npm --version" ||
    trimmed === "pnpm -v" ||
    trimmed === "pnpm --version" ||
    trimmed === "yarn -v" ||
    trimmed === "yarn --version" ||
    trimmed === "python3 --version" ||
    trimmed === "python --version"
  );
}

function isWorkerRole(role) {
  return role === "WORKER" || role === "FLASH" || role === "FLASH_WORKER" || role === "FLASH_MEDIUM_WORKER" || role === "FLASH_LOW_WORKER";
}

function isReviewerRole(role) {
  return role === "REVIEWER" || role === "FLASH_REVIEWER" || role === "OPUS";
}

function extractJsonArrayAfterKey(text, key) {
  if (typeof text !== "string") return { found: false, value: null };
  const keyMatch = new RegExp("\\b" + key + "\\s*:", "i").exec(text);
  if (!keyMatch) return { found: false, value: null };
  const start = text.indexOf("[", keyMatch.index + keyMatch[0].length);
  if (start < 0) return { found: true, value: null };

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) {
        const raw = text.slice(start, i + 1);
        try {
          return { found: true, value: JSON.parse(raw) };
        } catch {
          return { found: true, value: null };
        }
      }
    }
  }
  return { found: true, value: null };
}

function extractScopeContractFromPrompt(promptText = "", sub = {}) {
  let allowed = [];
  let forbidden = [];
  let tests = [];
  let requiredEvidence = [];
  let hasTestsRequired = false;
  let hasRequiredEvidence = false;

  if (sub.ScopeContract || sub.scopeContract) {
    const sc = sub.ScopeContract || sub.scopeContract;
    if (Array.isArray(sc.allowedPaths)) allowed = sc.allowedPaths;
    if (Array.isArray(sc.forbiddenPaths)) forbidden = sc.forbiddenPaths;
    if (Object.prototype.hasOwnProperty.call(sc, "testsRequired")) {
      hasTestsRequired = true;
      if (Array.isArray(sc.testsRequired)) tests = sc.testsRequired;
    }
    if (Object.prototype.hasOwnProperty.call(sc, "requiredEvidence")) {
      hasRequiredEvidence = true;
      if (Array.isArray(sc.requiredEvidence)) requiredEvidence = sc.requiredEvidence;
    }
  }

  if (allowed.length === 0 && typeof promptText === "string") {
    const allowedMatch = promptText.match(/allowedPaths\s*:\s*\[([^\]]*)\]/i);
    if (allowedMatch) {
      allowed = String(allowedMatch[1] || "")
        .split(",")
        .map((item) => item.trim().replace(/^["'\x60]|["'\x60]$/g, ""))
        .filter(Boolean);
    }
  }

  if (forbidden.length === 0 && typeof promptText === "string") {
    const forbiddenMatch = promptText.match(/forbiddenPaths\s*:\s*\[([^\]]*)\]/i);
    if (forbiddenMatch) {
      forbidden = String(forbiddenMatch[1] || "")
        .split(",")
        .map((item) => item.trim().replace(/^["'\x60]|["'\x60]$/g, ""))
        .filter(Boolean);
    }
  }

  if (!hasRequiredEvidence && typeof promptText === "string") {
    const parsed = extractJsonArrayAfterKey(promptText, "requiredEvidence");
    if (Array.isArray(parsed.value)) {
      hasRequiredEvidence = true;
      requiredEvidence = parsed.value;
    }
  }

  if (!hasTestsRequired && typeof promptText === "string") {
    const parsedTests = extractJsonArrayAfterKey(promptText, "testsRequired");
    if (Array.isArray(parsedTests.value)) {
      hasTestsRequired = true;
      tests = parsedTests.value;
    }

    if (!hasTestsRequired) {
      const codeMatch = promptText.match(/\x60((?:node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|pytest|cargo\s+test|vitest|jest)[^\x60\n]+)\x60/i);
      if (codeMatch && codeMatch[1]) {
        tests = [codeMatch[1].trim()];
        hasTestsRequired = true;
      }
    }

    if (!hasTestsRequired) {
      const testMatch = promptText.match(/(?:testsRequired|Validate(?: changes)?(?: using)?)\s*:\s*\x60?([^\x60\n]+)\x60?/i);
      if (testMatch && testMatch[1]) {
        const raw = testMatch[1].trim().replace(/^["'\x60]|["'\x60]$/g, "");
        if (raw.toLowerCase() !== "true" && raw.toLowerCase() !== "false") {
          tests = [raw];
          hasTestsRequired = true;
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
    requiredEvidence,
    hasTestsRequired,
    hasRequiredEvidence,
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
    console.log(JSON.stringify({
      decision: "deny",
      reason: "INVALID_HOOK_PAYLOAD: PreToolUse received no authorization payload."
    }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    console.log(JSON.stringify({
      decision: "deny",
      reason: "MALFORMED_HOOK_PAYLOAD: PreToolUse payload is not valid JSON."
    }));
    return;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    console.log(JSON.stringify({
      decision: "deny",
      reason: "INVALID_HOOK_PAYLOAD: PreToolUse payload must be a JSON object."
    }));
    return;
  }

  const toolCall = payload.toolCall && typeof payload.toolCall === "object" && !Array.isArray(payload.toolCall)
    ? payload.toolCall
    : (
      typeof payload.toolName === "string" && payload.toolName.trim()
        ? { name: payload.toolName, args: payload.toolArgs || payload.args || {} }
        : null
    );

  if (!toolCall || typeof toolCall.name !== "string" || !toolCall.name.trim()) {
    console.log(JSON.stringify({
      decision: "deny",
      reason: "INVALID_HOOK_PAYLOAD: PreToolUse payload is missing a valid tool call name."
    }));
    return;
  }

  const toolName = toolCall.name.trim();
  const toolArgs = toolCall.args && typeof toolCall.args === "object" && !Array.isArray(toolCall.args)
    ? toolCall.args
    : {};

  const { repoRoot, statePath, contractPath, roleBindingsPath, pendingExecutionsDir } = getWorkspacePaths(payload);

  let activeState = {};
  let activeContract = null;

  const stateLoad = readGovernanceObject(statePath, "ACTIVE_STATE");
  if (!stateLoad.ok) {
    console.log(JSON.stringify({
      decision: "deny",
      reason: `GOVERNANCE_STATE_INVALID: ${stateLoad.reason}. Existing governance state must be repaired before tool execution.`
    }));
    return;
  }
  if (stateLoad.exists) activeState = stateLoad.value;

  const contractLoad = readGovernanceObject(contractPath, "ACTIVE_CONTRACT");
  if (!contractLoad.ok) {
    console.log(JSON.stringify({
      decision: "deny",
      reason: `GOVERNANCE_STATE_INVALID: ${contractLoad.reason}. Existing scope contract must be repaired before tool execution.`
    }));
    return;
  }
  if (contractLoad.exists) {
    activeContract = contractLoad.value;
  } else if (activeState.scopeContract) {
    if (!activeState.scopeContract || typeof activeState.scopeContract !== "object" || Array.isArray(activeState.scopeContract)) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "GOVERNANCE_STATE_INVALID: ACTIVE_STATE_SCOPE_CONTRACT_INVALID_SHAPE."
      }));
      return;
    }
    activeContract = activeState.scopeContract;
  }

  const canaryTaskId =
    payload.taskId
    || payload.taskIdentifier
    || activeState.taskId
    || activeState.taskKey
    || process.env.BENCHMARK_TASK_ID
    || null;

  // A task that already entered live Canary may never cross into an external
  // side effect. Roll back first, deny this one tool call, then the task can
  // continue under the static policy on its next turn.
  if (isCanaryExternalSideEffect({ toolName, toolArgs })) {
    const rollback = rollbackSelectedCanaryTask({
      repoRoot,
      taskId: canaryTaskId,
      trigger: "EXTERNAL_SIDE_EFFECT_ATTEMPT",
      details: { tool_name: toolName },
    });
    if (rollback.rolled_back) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "CANARY_ROLLBACK: External side effects are ineligible during Canary. Session rolled back; retry/replan under static policy.",
      }));
      return;
    }
  }

  const roleBindings = loadRoleBindings(roleBindingsPath);
  if (roleBindings.__governanceLoadError) {
    console.log(JSON.stringify({
      decision: "deny",
      reason: `GOVERNANCE_STATE_INVALID: ${roleBindings.__governanceLoadError}. Role identity state must be repaired before tool execution.`
    }));
    return;
  }
  const actor = resolveActorIdentity(payload, activeState, roleBindings, repoRoot, roleBindingsPath);
  const activeRole = actor.role;
  const actorDelegationKind = actor.delegationKind || null;
  const actorIdentityIsProvisional = actor.source === "HOOK_PAYLOAD_CORRELATION";
  const actorIdentityIsFactual = actor.source === "RUNTIME_IDENTITY" && actor.confidence === "HIGH";
  const actorHasFactualWorkerAuthority = isWorkerRole(actor.role) && actorIdentityIsFactual;
  const actorHasOrchestratorAuthority = isOrchestratorRole(actor.role) && actor.confidence === "HIGH";
  const isInvestigatorActor = actorDelegationKind === "INVESTIGATION";
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

    if (!actorHasOrchestratorAuthority) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "ORCHESTRATOR_IDENTITY_REQUIRED: Subagent definition and invocation require HIGH-confidence orchestrator identity bound to the active main conversation."
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

      // Ensure the already-authorized orchestrator binding exists without
      // downgrading or overwriting stronger identity established earlier.
      if (!roleBindings.bindings) roleBindings.bindings = {};
      if (!roleBindings.conversations) roleBindings.conversations = {};
      const existingOrchestratorBinding = roleBindings.bindings[convId] || roleBindings.conversations[convId] || null;
      if (!existingOrchestratorBinding) {
        const orchRecord = {
          conversationId: convId,
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          model: payload.modelName || "gemini-3.8-flash-medium",
          source: actor.source || "CONVERSATION_BOUND_IDENTITY",
          confidence: "HIGH",
        };
        roleBindings.bindings[convId] = orchRecord;
        roleBindings.conversations[convId] = orchRecord;
      }

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

      const reviewerSubagents = subagents.filter(isReviewerSubagentDescriptor);
      const isReviewerBatch = reviewerSubagents.length > 0;
      const isTwoKeyBatch = subagents.length === 2 && reviewerSubagents.length === 2;
      const isCriticalTask = String(activeState.criticality || activeContract?.criticality || "").toUpperCase() === "CRITICAL";

      if (subagents.length > 1 && reviewerSubagents.length !== subagents.length) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "PARALLEL_MUTATING_SUBAGENTS_UNSUPPORTED: Multi-subagent batches are reserved for the read-only Two-Key reviewer pair. Delegate workers/investigators one at a time so scope contracts and causal identity remain unambiguous.",
        }));
        return;
      }

      if (isReviewerBatch && subagents.length !== 2) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "TWO_KEY_REVIEW_CARDINALITY: Reviewer dispatch must contain exactly two independent reviewers in one batch. Third-vote and single-reviewer critical consensus are prohibited.",
        }));
        return;
      }

      if (isCriticalTask && isReviewerBatch && !isTwoKeyBatch) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "TWO_KEY_REVIEW_REQUIRED: CRITICAL review requires exactly two independent reviewers.",
        }));
        return;
      }

      const reviewCandidateHead = isTwoKeyBatch ? readGitHead(repoRoot) : null;
      const reviewCandidateMutationSeq = isTwoKeyBatch
        ? (activeState.mutationSeq || activeState.mutation_seq || 0)
        : null;
      const reviewCandidateAttempt = isTwoKeyBatch
        ? (Number.isInteger(activeState.attempt) ? activeState.attempt : 0)
        : null;
      const reviewOriginToolCallId = isTwoKeyBatch ? (toolCall.id || payload.toolCallId || null) : null;

      if (isTwoKeyBatch && !reviewCandidateHead) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "TWO_KEY_CANDIDATE_IDENTITY_UNRESOLVED: Cannot dispatch critical reviewers without a factual Git HEAD for the candidate.",
        }));
        return;
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
        const rawModel = String(sub.Model || "").trim();
        const normalizedModel = rawModel.toLowerCase();
        let modelStr = rawModel || null;

        if (
          !normalizedModel ||
          normalizedModel === "inherit" ||
          normalizedModel === "low" ||
          normalizedModel === "flash_lite" ||
          normalizedModel === "flash-lite" ||
          normalizedModel === "medium" ||
          normalizedModel === "flash" ||
          normalizedModel === "flash_medium" ||
          normalizedModel === "flash-medium" ||
          normalizedModel === "pro" ||
          normalizedModel === "high"
        ) {
          if (isReviewer) {
            modelStr = "gemini-3.8-flash-high";
          } else if (
            normalizedModel === "low" ||
            normalizedModel === "flash_lite" ||
            normalizedModel === "flash-lite" ||
            profile === "flash-low-worker"
          ) {
            modelStr = "gemini-3.8-flash-low";
          } else if (
            normalizedModel === "medium" ||
            normalizedModel === "flash" ||
            normalizedModel === "flash_medium" ||
            normalizedModel === "flash-medium" ||
            profile === "flash-medium-worker"
          ) {
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
          attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
          toolCallId,
          originToolCallId: toolCallId,
          originStepIdx: payload.stepIdx ?? null,
          delegationKind,
          reviewBatchId: isReviewer ? reviewOriginToolCallId : null,
          reviewCandidateHead: isReviewer ? reviewCandidateHead : null,
          reviewCandidateMutationSeq: isReviewer ? reviewCandidateMutationSeq : null,
          reviewCandidateAttempt: isReviewer ? reviewCandidateAttempt : null,
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
                repoRoot,
                decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
                state: decisionState,
                availableActions: invAvailable,
                baselineAction: invBaseline,
                activeState,
                activeContract: contractObj,
                taskId: payload.taskId || payload.taskIdentifier || activeState.taskId || activeState.taskKey || process.env.BENCHMARK_TASK_ID || null,
              });
              if (invEval.block_execution) {
                console.log(JSON.stringify({
                  decision: "deny",
                  reason: `EXPLORATION_POLICY_INVALID: ${invEval.policy_diagnostic || "blocked"}`,
                }));
                return;
              }
              if (invEval.action === "INVESTIGATE_FIRST") {
                activeState.pendingPolicyRequirement = {
                  decision_type: DECISION_TYPES.INVESTIGATION_STRATEGY,
                  selected_action: "INVESTIGATE_FIRST",
                  policy_source: invEval.source,
                  policy_id: invEval.policy_id,
                  baseline_action: invBaseline,
                  policy_diagnostic: invEval.policy_diagnostic,
                  source_snapshot_id: invEval.source_snapshot_id || null,
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
            repoRoot,
            decisionType,
            state: decisionState,
            availableActions,
            baselineAction,
            activeState,
            activeContract: contractObj,
            taskId: payload.taskId || payload.taskIdentifier || activeState.taskId || activeState.taskKey || process.env.BENCHMARK_TASK_ID || null,
          });
          if (evalResult.block_execution) {
            console.log(JSON.stringify({
              decision: "deny",
              reason: `EXPLORATION_POLICY_INVALID: ${evalResult.policy_diagnostic || "blocked"}`,
            }));
            return;
          }

          // RETRY_ACTION=INVESTIGATE_FIRST is published only when the factual
          // investigation dispatch begins; defer BranchSeed capture until then.
          if (!(decisionType === DECISION_TYPES.RETRY_ACTION && evalResult.action === "INVESTIGATE_FIRST")) {
            const seedCapture = captureBranchSeedIfArmed({
              repoRoot,
              snapshot: snapRes.snapshot,
              decisionType,
              decisionState,
              availableActions,
              scopeContract: contractObj,
              taskDescriptor: taskObj,
              evidenceSummary: evidenceObj,
              runtimeState: activeState,
            });
            if (seedCapture.captured) {
              activeState.explorationSeedCaptured = seedCapture.seed_id;
              try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
            }
          }

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
                snapshot: evalResult.source_snapshot_id || snapRes.snapshot,
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
              consumeExplorationTarget({
                repoRoot,
                decisionType: DECISION_TYPES.RETRY_ACTION,
                state: decisionState,
                action: "REPLAN",
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
            snapshot: evalResult.source_snapshot_id || snapRes.snapshot,
            decision: decRecordInput,
            correlationKey: corrKey,
            profile,
          });
        }
      }

      // All subagents approved: commit state, bindings, and record decisions.
      // A Two-Key batch is bound to the exact candidate version visible at dispatch.
      if (isTwoKeyBatch) {
        activeState.twoKeyReview = {
          status: "IN_FLIGHT",
          reviewBatchId: reviewOriginToolCallId,
          candidateHead: reviewCandidateHead,
          candidateMutationSeq: reviewCandidateMutationSeq,
          candidateAttempt: reviewCandidateAttempt,
          expectedReviewerCount: 2,
          reviewerConversationIds: [],
          reviews: {},
          startedAt: new Date().toISOString(),
        };
        activeState.twoKeyReviewConsensus = null;
      }

      roleBindings.pendingSubagents.push(...candidatePending);
      roleBindings.pendingSeq = seq;
      saveRoleBindings(roleBindingsPath, roleBindings);

      // Build a delegation-local Scope Contract for every child, but only
      // implementation WORK may replace the active acceptance contract.
      // REVIEW/INVESTIGATION prompts must never redefine implementation tests/paths.
      for (let subIdx = 0; subIdx < subagents.length; subIdx++) {
        const sub = subagents[subIdx];
        const pending = candidatePending[subIdx];
        const promptText = sub.Prompt || "";
        const extracted = extractScopeContractFromPrompt(promptText, sub);
        const baseAllowedPaths = activeContract?.allowedPaths || [];
        const baseForbiddenPaths = activeContract?.forbiddenPaths || [".agents/**"];
        const baseTestsRequired = activeContract?.testsRequired || [];
        const baseRequiredEvidence = activeContract?.requiredEvidence || [];

        const delegationContract = {
          ...(activeContract && typeof activeContract === "object" ? activeContract : {}),
          contractId: `delegation-contract-${toolCall.id || payload.toolCallId || "unknown"}-${subIdx}`,
          taskId: activeState.taskId || activeState.taskKey || activeContract?.taskId || null,
          targetAgent: sub.TypeName || (pending?.role === "REVIEWER" ? "flash-reviewer" : "flash-low-worker"),
          delegationKind: pending?.delegationKind || null,
          criticality: String(activeState.criticality || activeContract?.criticality || "NORMAL").toUpperCase(),
          allowedPaths: extracted.allowedPaths.length > 0 ? extracted.allowedPaths : baseAllowedPaths,
          forbiddenPaths: extracted.forbiddenPaths.length > 0 ? extracted.forbiddenPaths : baseForbiddenPaths,
          testsRequired: extracted.hasTestsRequired ? extracted.testsRequired : baseTestsRequired,
          requiredEvidence: extracted.hasRequiredEvidence ? extracted.requiredEvidence : baseRequiredEvidence,
          createdAt: new Date().toISOString(),
        };

        if (pending) {
          pending.scopeContract = delegationContract;
        }

        if (pending?.delegationKind === "WORK") {
          const implementationContract = {
            ...delegationContract,
            contractId: activeContract?.contractId || `contract-${Date.now()}`,
            createdAt: activeContract?.createdAt || delegationContract.createdAt,
          };
          activeContract = implementationContract;
          activeState.scopeContract = implementationContract;
          try {
            mkdirSync(dirname(contractPath), { recursive: true });
            writeFileSync(contractPath, JSON.stringify(implementationContract, null, 2), "utf-8");
          } catch {}
        }
      }

      // Persist pending records again after attaching delegation-local contracts.
      saveRoleBindings(roleBindingsPath, roleBindings);

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
        consumeExplorationTarget({
          repoRoot,
          decisionType: item.decision.decision_type,
          state: item.decision.state,
          action: item.decision.chosen_action,
        });
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

  // Check 1: agent-to-agent messaging is parent/child only and identity-bound.
  if (toolName === "send_message") {
    const recipient = String(
      toolArgs.Recipient || toolArgs.recipient || toolArgs.ConversationId || toolArgs.conversationId || ""
    ).trim();

    if (!recipient) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "MESSAGE_RECIPIENT_REQUIRED: send_message requires an explicit recipient conversationId."
      }));
      return;
    }

    if (isReviewerRole(activeRole)) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "REVIEWER_MESSAGE_PROHIBITED: Two-Key reviewers are isolated and cannot send agent-to-agent messages."
      }));
      return;
    }

    if (isWorkerRole(activeRole)) {
      if (!(actor.source === "RUNTIME_IDENTITY" && actor.confidence === "HIGH")) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "MESSAGE_IDENTITY_REQUIRED: Worker/investigator messaging requires factual HIGH runtime identity."
        }));
        return;
      }
      const actorBinding = roleBindings.bindings?.[actor.actorId]
        || roleBindings.conversations?.[actor.actorId]
        || null;
      const expectedParent = actorBinding?.parentConversationId || null;
      if (!expectedParent || recipient !== expectedParent) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "CROSS_AGENT_MESSAGE_PROHIBITED: Subagents may send messages only to their factual parent Orchestrator."
        }));
        return;
      }
      console.log(JSON.stringify({ decision: "allow" }));
      return;
    }

    if (isOrchestratorRole(activeRole)) {
      if (!actorHasOrchestratorAuthority) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "MESSAGE_IDENTITY_REQUIRED: Orchestrator messaging requires HIGH main-conversation identity."
        }));
        return;
      }
      if (isHealthyDelegatedExecution(activeState, activeRole)) {
        const reason = "Reactive Wakeup policy: Orchestrator send_message is prohibited during healthy delegated execution. Yield and await child completion.";
        recordDeniedAttempt(activeState, statePath, "send_message", toolArgs, reason);
        console.log(JSON.stringify({ decision: "deny", reason }));
        return;
      }

      const recipientBinding = roleBindings.bindings?.[recipient]
        || roleBindings.conversations?.[recipient]
        || null;
      if (
        !recipientBinding ||
        recipientBinding.parentConversationId !== actor.actorId ||
        recipientBinding.source !== "RUNTIME_IDENTITY" ||
        recipientBinding.confidence !== "HIGH"
      ) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "CROSS_AGENT_MESSAGE_PROHIBITED: Orchestrator may message only a factual child bound to this main conversation."
        }));
        return;
      }
      console.log(JSON.stringify({ decision: "allow" }));
      return;
    }

    console.log(JSON.stringify({
      decision: "deny",
      reason: "MESSAGE_IDENTITY_REQUIRED: Unresolved actors cannot send agent-to-agent messages."
    }));
    return;
  }

  // Check 1a: schedule / timer policy during delegated execution
  if (toolName === "schedule") {
    if (!actorHasOrchestratorAuthority) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "COORDINATION_AUTHORITY_REQUIRED: schedule is reserved for the HIGH-confidence main Orchestrator."
      }));
      return;
    }
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
    if (!actorHasOrchestratorAuthority) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "COORDINATION_AUTHORITY_REQUIRED: manage_task is reserved for the HIGH-confidence main Orchestrator."
      }));
      return;
    }
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
    if (!actorHasOrchestratorAuthority) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "COORDINATION_AUTHORITY_REQUIRED: manage_subagents is reserved for the HIGH-confidence main Orchestrator."
      }));
      return;
    }
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

    if (targets.some(isRepositoryConstitutionPath) || redir.targets.some(isRepositoryConstitutionPath)) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "AGENTS.md is the provider-neutral repository constitution and is strictly read-only for all agents."
      }));
      return;
    }

    if (
      isOrchestratorRole(activeRole) &&
      (targets.some(isAgentControlPlanePath) || redir.targets.some(isAgentControlPlanePath))
    ) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "HOOK_OWNED_GOVERNANCE_STATE: .agents/** is runtime-hook-owned. Orchestrator may inspect it but cannot mutate governance state directly."
      }));
      return;
    }

    // Investigator is a specialist read-only plane even though it reuses the
    // flash-worker profile/model. Delegation purpose, not profile, controls authority.
    if (isInvestigatorActor) {
      const mutation = classifyShellMutation(cmd);
      const safeInvestigationCommand =
        !hasWorkspaceMutationTargets &&
        redir.targets.length === 0 &&
        (
          isReadOnly ||
          (actorIdentityIsFactual && isValidation && mutation.isMutation === false)
        );
      if (safeInvestigationCommand) {
        allowCommand(cmd);
        return;
      }
      console.log(JSON.stringify({
        decision: "deny",
        reason: "INVESTIGATOR_READ_ONLY: Investigation delegation is strictly non-mutating. Return findings to Orchestrator; implementation must be delegated separately."
      }));
      return;
    }

    // Unknown role: shell is privileged even when the command looks read-only.
    // Unresolved actors may use native inspection tools, but never receive terminal authority.
    if (!activeRole || activeRole === "UNKNOWN") {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "ROLE_IDENTITY_UNRESOLVED: Actor identity could not be verified by runtime evidence. Shell execution is prohibited for unresolved roles."
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

      const allScratchTargets = (targets.length > 0 || redir.targets.length > 0) &&
        targets.every(isOrchestratorScratchPath) && redir.targets.every(isOrchestratorScratchPath);
      if (allScratchTargets) {
        allowCommand(cmd);
        return;
      }

      console.log(JSON.stringify({
        decision: "deny",
        reason: `ORCHESTRATOR_UNVERIFIED_COMMAND_PROHIBITED: Separation of duties violation: Orchestrator cannot run unverified or arbitrary shell commands ("${cmd}") whose side effects cannot be proven safe. Normal orchestration permits only known read-only commands, known validation commands, and verified control-plane operations. Delegate implementation to Gemini Flash.`
      }));
      return;
    }

    // 2c. Worker (Flash): shell authority requires factual child identity.
    if (isWorkerRole(activeRole)) {
      if (isReadOnly) {
        allowCommand(cmd);
        return;
      }

      if (!actorHasFactualWorkerAuthority) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "ROLE_IDENTITY_NOT_FACTUAL: Worker shell execution beyond read-only inspection requires HIGH RUNTIME_IDENTITY."
        }));
        return;
      }

      if (!activeContract) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "SCOPE_VIOLATION: Worker shell execution beyond read-only inspection requires an active Scope Contract."
        }));
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

      const mutation = classifyShellMutation(cmd);
      if (!mutation.isMutation) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "WORKER_UNVERIFIED_SHELL_COMMAND: Non-validation shell command is neither read-only nor a deterministically classified mutation. Use native tools or an explicitly scoped mutation command."
        }));
        return;
      }

      const effectiveTargets = [...targets];
      if (mutation.targetPath) {
        const normalizedMutationTarget = normalizePath(
          String(mutation.targetPath).startsWith(repoRoot)
            ? relative(repoRoot, String(mutation.targetPath))
            : String(mutation.targetPath)
        );
        if (normalizedMutationTarget && !effectiveTargets.includes(normalizedMutationTarget)) {
          effectiveTargets.push(normalizedMutationTarget);
        }
      }

      if (effectiveTargets.some(isWorkspaceEscapePath)) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "WORKSPACE_ESCAPE: Mutating worker shell command resolves a target outside the repository workspace."
        }));
        return;
      }

      if (effectiveTargets.some(isAgentControlPlanePath)) {
        rollbackSelectedCanaryTask({
          repoRoot,
          taskId: canaryTaskId,
          trigger: "GOVERNANCE_MODIFICATION_ATTEMPT",
          details: { tool_name: toolName, targets: effectiveTargets },
        });
        console.log(JSON.stringify({
          decision: "deny",
          reason: "CONTROL_PLANE_WRITE_PROHIBITED: Workers cannot modify .agents/** regardless of Scope Contract."
        }));
        return;
      }

      if (effectiveTargets.length === 0 || (mutation.unknownScope && !mutation.targetPath && targets.length === 0)) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "SCOPE_UNRESOLVED: Mutating worker shell command has no deterministic target path. Use a native file tool or provide an explicitly scoped command."
        }));
        return;
      }

      const allowed = Array.isArray(activeContract.allowedPaths) ? activeContract.allowedPaths : [];
      const forbidden = Array.isArray(activeContract.forbiddenPaths) ? activeContract.forbiddenPaths : [];

      if (allowed.length === 0) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "SCOPE_VIOLATION: Worker has no allowedPaths specified in active Scope Contract."
        }));
        return;
      }

      for (const t of effectiveTargets) {
        for (const pattern of forbidden) {
          if (pathMatchesPattern(t, pattern)) {
            console.log(JSON.stringify({
              decision: "deny",
              reason: `Scope contract violation: shell command targets forbidden path "${t}" matching "${pattern}".`
            }));
            return;
          }
        }

        const isAllowed = allowed.some((pattern) => pathMatchesPattern(t, pattern));
        if (!isAllowed) {
          console.log(JSON.stringify({
            decision: "deny",
            reason: `Scope contract violation: shell command targets path "${t}" outside allowedPaths [${allowed.join(", ")}]. If required, return CROSS_DOMAIN_REQUEST to Orchestrator.`
          }));
          return;
        }
      }

      allowCommand(cmd);
      return;
    }
    allowCommand(cmd);
    return;
  }

  // Check 3: native file mutation tools
  if (["write_to_file", "replace_file_content", "edit_file", "create_file"].includes(toolName)) {
    const rawTarget = toolArgs.TargetFile || toolArgs.targetFile || toolArgs.FilePath || toolArgs.filePath || toolArgs.path || "";
    const canonicalTarget = canonicalizeWorkspaceTarget(rawTarget, repoRoot);
    const relTarget = canonicalTarget.path;

    if (canonicalTarget.outsideWorkspace) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: `WORKSPACE_ESCAPE: File mutation target "${rawTarget}" resolves outside the repository workspace.`
      }));
      return;
    }

    // 0. Constitution protection: AGENTS.md is strictly immutable across all agents
    if (relTarget === "AGENTS.md" || relTarget.endsWith("/AGENTS.md")) {
      rollbackSelectedCanaryTask({
        repoRoot,
        taskId: canaryTaskId,
        trigger: "GOVERNANCE_MODIFICATION_ATTEMPT",
        details: { tool_name: toolName, target: relTarget },
      });
      console.log(JSON.stringify({
        decision: "deny",
        reason: "AGENTS.md is the provider-neutral repository constitution and is strictly read-only for all agents."
      }));
      return;
    }

    // Investigator: strictly read-only. Reusing a flash-worker model/profile
    // never grants implementation authority to an INVESTIGATION delegation.
    if (isInvestigatorActor) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: `INVESTIGATOR_READ_ONLY: Investigation delegation cannot modify files ("${relTarget}"). Return findings to Orchestrator for a separate implementation handoff.`
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

    // Worker mutation authority is granted only by factual runtime child identity.
    // STATE_DERIVED and HOOK_PAYLOAD_CORRELATION may restrict behavior but cannot authorize writes.
    if (isWorkerRole(activeRole) && !actorHasFactualWorkerAuthority) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: "ROLE_IDENTITY_NOT_FACTUAL: Worker mutation requires HIGH RUNTIME_IDENTITY. State-derived or hook-payload roles are not write authorization."
      }));
      return;
    }

    const isControlPlane = isControlPlanePath(relTarget);

    if (isWorkerRole(activeRole) && isAgentControlPlanePath(relTarget)) {
      rollbackSelectedCanaryTask({
        repoRoot,
        taskId: canaryTaskId,
        trigger: "GOVERNANCE_MODIFICATION_ATTEMPT",
        details: { tool_name: toolName, target: relTarget },
      });
      console.log(JSON.stringify({
        decision: "deny",
        reason: `CONTROL_PLANE_WRITE_PROHIBITED: Workers cannot modify .agents/** ("${relTarget}") regardless of Scope Contract.`
      }));
      return;
    }

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

    // 4. Orchestrator: runtime governance state is hook-owned. The only writable
    // workspace surface for the orchestrator is scratch/ for ephemeral analysis.
    if (isOrchestratorRole(activeRole)) {
      if (isOrchestratorScratchPath(relTarget)) {
        console.log(JSON.stringify({ decision: "allow" }));
        return;
      }
      if (isAgentControlPlanePath(relTarget)) {
        rollbackSelectedCanaryTask({
          repoRoot,
          taskId: canaryTaskId,
          trigger: "GOVERNANCE_MODIFICATION_ATTEMPT",
          details: { tool_name: toolName, target: relTarget },
        });
        console.log(JSON.stringify({
          decision: "deny",
          reason: `HOOK_OWNED_GOVERNANCE_STATE: .agents/** ("${relTarget}") is runtime-hook-owned. Orchestrator may inspect governance state but cannot write it directly.`
        }));
        return;
      }
      console.log(JSON.stringify({
        decision: "deny",
        reason: `ORCHESTRATOR_WORKSPACE_WRITE_PROHIBITED: Separation of duties violation: Orchestrator is forbidden from directly writing product code or workspace files ("${relTarget}"). Delegate implementation to Gemini Flash.`
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
            repoRoot,
            decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
            state: invState,
            availableActions: invAvailable,
            baselineAction: invBaseline,
            activeState,
            activeContract,
            taskId: payload.taskId || payload.taskIdentifier || activeState.taskId || activeState.taskKey || process.env.BENCHMARK_TASK_ID || null,
          });
          if (invRes.block_execution) {
            console.log(JSON.stringify({
              decision: "deny",
              reason: `EXPLORATION_POLICY_INVALID: ${invRes.policy_diagnostic || "blocked"}`,
            }));
            return;
          }
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
              const seedCapture = captureBranchSeedIfArmed({
                repoRoot,
                snapshot: snapRes.snapshot,
                decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
                decisionState: invState,
                availableActions: invAvailable,
                scopeContract: activeContract || { allowed_paths: [], forbidden_paths: [".agents/**"], criticality: "NORMAL" },
                taskDescriptor: taskObj,
                evidenceSummary: activeState.evidenceSummary || activeState.evidence || {},
                runtimeState: activeState,
              });
              if (seedCapture.captured) {
                activeState.explorationSeedCaptured = seedCapture.seed_id;
              }

              const corrKey = dreamCorrelationKey({
                conversationId: payload.conversationId || activeState.conversationId || "default",
                stepIdx: payload.stepIdx ?? 0,
                toolCallId: toolCall.id || payload.toolCallId || "",
                branchOrdinal: 0,
              });
              const directDecision = recordDecision({
                repoRoot,
                snapshot: invRes.source_snapshot_id || snapRes.snapshot,
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
              consumeExplorationTarget({
                repoRoot,
                decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
                state: invState,
                action: "IMPLEMENT_DIRECT",
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
