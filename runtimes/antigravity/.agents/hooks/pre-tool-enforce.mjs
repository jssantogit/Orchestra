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
} from "../skills/agy-orchestra/routing-policy.mjs";

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
          candidates = candidates.filter((c) => !c.parentConversationId || c.parentConversationId === parentConvId);
        }
        const activeTaskId = payload.taskId || payload.taskIdentifier || activeState.taskId || activeState.taskKey || null;
        if (activeTaskId) {
          candidates = candidates.filter((c) => !(c.taskIdentifier || c.taskId) || (c.taskIdentifier || c.taskId) === activeTaskId);
        }
        const activeRunId = payload.benchmarkRunId || activeState.benchmarkRunId || null;
        if (activeRunId) {
          candidates = candidates.filter((c) => !c.benchmarkRunId || c.benchmarkRunId === activeRunId);
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
          if (allSameRoleAndProfile) {
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

          const childRole = matched.role || "WORKER";
          const childProfile = matched.profile || matched.typeName || (childRole === "REVIEWER" ? "flash-reviewer" : "flash-worker");
          const childModel = matched.model || payload.modelName || (childRole === "REVIEWER" ? "gemini-3.8-flash-high" : "gemini-3.8-flash");

          if (!roleBindings.bindings) roleBindings.bindings = {};
          if (!roleBindings.conversations) roleBindings.conversations = {};
          const record = {
            conversationId: convId,
            role: childRole,
            profile: childProfile,
            model: childModel,
            parentConversationId: matched.parentConversationId || roleBindings.mainConversationId || null,
            taskIdentifier: matched.taskIdentifier || activeTaskId || null,
            benchmarkRunId: matched.benchmarkRunId || activeRunId || null,
            confidence: "HIGH",
            source: "RUNTIME_IDENTITY",
            consumed: true,
            consumedBy: convId,
            consumedAt,
          };
          roleBindings.bindings[convId] = record;
          roleBindings.conversations[convId] = record;
          if (roleBindingsPath) {
            saveRoleBindings(roleBindingsPath, roleBindings);
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

function isValidationCommand(cmd) {
  const trimmed = cmd.trim();
  const redir = extractRealShellRedirections(cmd);
  if (redir.targets.length > 0) return false;

  return (
    trimmed.startsWith("pnpm test") ||
    trimmed.startsWith("pnpm --filter") ||
    trimmed.startsWith("pnpm run test") ||
    trimmed.startsWith("pnpm typecheck") ||
    trimmed.startsWith("pnpm run typecheck") ||
    trimmed.startsWith("pnpm lint") ||
    trimmed.startsWith("pnpm run lint") ||
    trimmed.startsWith("pnpm build") ||
    trimmed.startsWith("pnpm run build") ||
    trimmed.startsWith("npm test") ||
    trimmed.startsWith("npm run test") ||
    trimmed.startsWith("npm run build") ||
    trimmed.startsWith("npm run typecheck") ||
    trimmed.startsWith("npm run lint") ||
    trimmed.startsWith("yarn test") ||
    trimmed.startsWith("yarn run test") ||
    trimmed.startsWith("yarn build") ||
    trimmed.startsWith("yarn typecheck") ||
    trimmed.startsWith("node --test") ||
    trimmed.startsWith("vitest") ||
    trimmed.startsWith("npx vitest") ||
    trimmed.startsWith("jest") ||
    trimmed.startsWith("npx jest") ||
    trimmed.startsWith("tsc --noEmit") ||
    trimmed.startsWith("npx tsc --noEmit") ||
    trimmed.startsWith("tsc") ||
    trimmed.startsWith("git diff --check")
  );
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
      let seq = roleBindings.pendingSeq || 0;
      for (let idx = 0; idx < subagents.length; idx++) {
        seq++;
        const sub = subagents[idx];
        const typeName = sub.TypeName || sub.name || "";
        const roleStr = String(sub.Role || typeName).toLowerCase();
        const isReviewer = roleStr.includes("reviewer") || typeName === "flash-reviewer";
        const subRole = isReviewer ? "REVIEWER" : "WORKER";
        let profile = typeName;
        if (!profile) {
          profile = isReviewer ? "flash-reviewer" : (activeState.requested_agent || "flash-worker");
        }
        let modelStr = sub.Model || null;
        if (!modelStr) {
          if (isReviewer) {
            modelStr = "gemini-3.8-flash-high";
          } else if (profile === "flash-low-worker") {
            modelStr = "gemini-3.8-flash-low";
          } else if (profile === "flash-medium-worker") {
            modelStr = "gemini-3.8-flash-medium";
          } else {
            modelStr = "gemini-3.8-flash";
          }
        }

        const taskId = activeState.taskId || activeState.taskKey || null;
        const benchmarkRunId = activeState.benchmarkRunId || null;
        const toolCallId = payload.toolCallId || null;

        roleBindings.pendingSubagents.push({
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
          creationOrder: idx,
          timestamp: new Date().toISOString(),
          consumed: false,
          consumedBy: null,
          consumedAt: null,
        });
      }
      roleBindings.pendingSeq = seq;
      saveRoleBindings(roleBindingsPath, roleBindings);

      // Deterministic Bookkeeping: auto-persist Scope Contract from invoke_subagent payload/prompt
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
      try {
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8");
      } catch {}
    }

    console.log(JSON.stringify({ decision: "allow" }));
    return;
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
      const reason = "Reactive Wakeup policy: Routine schedule/timer calls are prohibited for Orchestrator during healthy delegated execution. Yield and await asynchronous reactive wakeup on child completion.";
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
      if (isReadOnly || isValidation) {
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
