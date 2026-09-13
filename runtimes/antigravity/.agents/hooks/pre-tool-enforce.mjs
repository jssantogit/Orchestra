import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import {
  extractRealShellRedirections,
  TOOL_OUTPUT_LIMITS,
  POLLING_POLICY,
  checkPollingBudget,
} from "../skills/agy-orchestra/routing-policy.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
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

function getWorkspacePaths() {
  const cwd = process.cwd();
  const repoRoot = existsSync(resolve(cwd, "packages"))
    ? cwd
    : (existsSync(resolve(cwd, "../packages")) ? resolve(cwd, "..") : cwd);
  return {
    repoRoot,
    statePath: resolve(repoRoot, ".agents/state/active-state.json"),
    contractPath: resolve(repoRoot, ".agents/state/active-contract.json"),
    pendingExecutionsDir: resolve(repoRoot, ".agents/state/executions/pending"),
  };
}

function isProductPath(p) {
  const norm = normalizePath(p);
  return norm.startsWith("packages/") || norm.startsWith("apps/") || norm.startsWith("vendor/");
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
    trimmed.startsWith("node --test") ||
    trimmed.startsWith("vitest") ||
    trimmed.startsWith("jest") ||
    trimmed.startsWith("tsc --noEmit") ||
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
    trimmed.startsWith("pnpm -v") ||
    trimmed.startsWith("pnpm --version") ||
    trimmed.startsWith("python3 --version") ||
    trimmed.startsWith("agy ")
  );
}

function isWorkerRole(role) {
  return role === "WORKER" || role === "FLASH" || role === "FLASH_WORKER" || role === "FLASH_MEDIUM_WORKER" || role === "FLASH_LOW_WORKER";
}

function isReviewerRole(role) {
  return role === "REVIEWER" || role === "FLASH_REVIEWER" || role === "OPUS";
}

function isOrchestratorRole(role) {
  return role === "ORCHESTRATOR" || role === "FLASH_ORCHESTRATOR" || role === "SONNET";
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

  const { repoRoot, statePath, contractPath, pendingExecutionsDir } = getWorkspacePaths();

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

  const activeRole = String(activeState.activeRole || activeState.role || "").toUpperCase();
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

  // Check 1b: manage_task polling budget
  if (toolName === "manage_task") {
    const action = String(toolArgs.Action || toolArgs.action || "");
    if (action === "status") {
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

    // 2b. Orchestrator: allow read-only and validation; block shell mutations to product code
    if (isOrchestratorRole(activeRole)) {
      if (isReadOnly || isValidation) {
        const productTarget = targets.find(isProductPath);
        if (productTarget) {
          console.log(JSON.stringify({
            decision: "deny",
            reason: `Separation of duties violation: Orchestrator is forbidden from redirecting output to product code ("${productTarget}"). Delegate implementation to Gemini Flash.`
          }));
          return;
        }
        allowCommand(cmd);
        return;
      }

      // Mutating command by Orchestrator targeting product code
      const productTarget = targets.find(isProductPath);
      if (productTarget) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: `Separation of duties violation: Orchestrator is forbidden from modifying product code ("${productTarget}") via shell commands. Delegate implementation to Gemini Flash.`
        }));
        return;
      }

      if (/\b(sed\s+-[a-zA-Z]*i|rm|mv|cp|touch)\b/.test(cmd) && (cmd.includes("packages/") || cmd.includes("apps/"))) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: `Separation of duties violation: Orchestrator is forbidden from modifying product code via shell commands. Delegate implementation to Gemini Flash.`
        }));
        return;
      }

      const allNonProduct = targets.length > 0 && targets.every(t => t.startsWith(".agents/") || t.startsWith(".gemini/") || t.startsWith("scratch/"));
      if (allNonProduct) {
        allowCommand(cmd);
        return;
      }

      if (targets.length > 0 || redir.targets.length > 0) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: `Separation of duties violation: Orchestrator cannot run unverified mutating shell commands against potential product paths.`
        }));
        return;
      }

      allowCommand(cmd);
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

    const isControlPlane = relTarget.startsWith(".agents/") || relTarget.startsWith(".gemini/") || relTarget.endsWith("AGENTS.md") || relTarget.startsWith("scratch/");
    const isProductCode = isProductPath(relTarget);

    if (isDirectAction && !isControlPlane) {
      if (!activeState.toolMix) activeState.toolMix = {};
      activeState.toolMix.direct_action_side_quests_prevented = (activeState.toolMix.direct_action_side_quests_prevented || 0) + 1;
      try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
      console.log(JSON.stringify({
        decision: "deny",
        reason: `DIRECT_ACTION_SIDE_QUEST: Modifying files ("${relTarget}") during DIRECT_ACTION is strictly prohibited by Exact Intent Boundary. Report blockers instead of performing side quests.`
      }));
      return;
    }

    if (isReviewerRole(activeRole)) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: `Separation of duties violation: Reviewer is strictly read-only and is forbidden from modifying files (${relTarget}). Report findings to Orchestrator.`
      }));
      return;
    }

    if (isOrchestratorRole(activeRole) && isProductCode) {
      console.log(JSON.stringify({
        decision: "deny",
        reason: `Separation of duties violation: Orchestrator is forbidden from directly writing product code (${relTarget}). Delegate implementation to Gemini Flash.`
      }));
      return;
    }

    if (activeContract && !isControlPlane) {
      const allowed = Array.isArray(activeContract.allowedPaths) ? activeContract.allowedPaths : [];
      const forbidden = Array.isArray(activeContract.forbiddenPaths) ? activeContract.forbiddenPaths : [];

      for (const pattern of forbidden) {
        if (pathMatchesPattern(relTarget, pattern)) {
          console.log(JSON.stringify({
            decision: "deny",
            reason: `Scope contract violation: "${relTarget}" matches forbiddenPaths pattern "${pattern}".`
          }));
          return;
        }
      }

      if (allowed.length > 0) {
        const isAllowed = allowed.some((pattern) => pathMatchesPattern(relTarget, pattern));
        if (!isAllowed) {
          console.log(JSON.stringify({
            decision: "deny",
            reason: `Scope contract violation: "${relTarget}" is outside allowedPaths [${allowed.join(", ")}]. If required, return CROSS_DOMAIN_REQUEST to Orchestrator.`
          }));
          return;
        }
      }
    }

    console.log(JSON.stringify({ decision: "allow" }));
    return;
  }

  console.log(JSON.stringify({ decision: "allow" }));
}

main();
