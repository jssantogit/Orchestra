import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";
import { createCodexDelegationExecutor } from "../../providers/codex/delegation-executor.mjs";
import { runBoundedProcess } from "./process-runner.mjs";

const UNAVAILABLE_REASON = "PROVIDER_UNAVAILABLE";
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_MAX_OUTPUT_BYTES = 64 * 1024;

function normalizedUnavailable(provider) {
  return {
    available: false,
    provider,
    reason: UNAVAILABLE_REASON,
  };
}

function validateExecutors(executors) {
  if (!Array.isArray(executors) || executors.length === 0) {
    throw new TypeError("DELEGATION_DISCOVERY_EXECUTORS_REQUIRED");
  }
  const seen = new Set();
  for (const executor of executors) {
    if (!executor
        || typeof executor !== "object"
        || typeof executor.provider !== "string"
        || executor.provider.length === 0
        || typeof executor.discover !== "function"
        || seen.has(executor.provider)) {
      throw new TypeError("DELEGATION_DISCOVERY_EXECUTOR_INVALID");
    }
    seen.add(executor.provider);
  }
}

function normalizeDiscovery(provider, value) {
  if (!value
      || typeof value !== "object"
      || Array.isArray(value)
      || value.provider !== provider
      || typeof value.available !== "boolean") {
    return normalizedUnavailable(provider);
  }
  if (!value.available) return normalizedUnavailable(provider);
  return {
    ...value,
    available: true,
    provider,
  };
}

export async function discoverDelegationProviders({ executors } = {}) {
  validateExecutors(executors);
  const providers = [];
  for (const executor of executors) {
    try {
      providers.push(normalizeDiscovery(executor.provider, await executor.discover()));
    } catch {
      providers.push(normalizedUnavailable(executor.provider));
    }
  }

  const availableCount = providers.filter((entry) => entry.available).length;
  return {
    status: availableCount === providers.length
      ? "READY"
      : availableCount === 0
        ? "UNAVAILABLE"
        : "DEGRADED",
    availableCount,
    providers,
  };
}

async function inspectGitWorktree(runProcess) {
  try {
    const result = await runProcess({
      command: "git",
      args: ["worktree", "list", "--porcelain"],
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      maxOutputBytes: DISCOVERY_MAX_OUTPUT_BYTES,
    });
    return {
      available: result?.exitCode === 0
        && result?.timedOut !== true
        && result?.stdoutTruncated !== true
        && result?.stderrTruncated !== true,
    };
  } catch {
    return { available: false };
  }
}

export async function inspectDelegationCapabilities({ runProcess = runBoundedProcess } = {}) {
  if (typeof runProcess !== "function") {
    throw new TypeError("DELEGATION_DISCOVERY_RUNNER_REQUIRED");
  }

  const gitWorktree = await inspectGitWorktree(runProcess);
  const executors = [
    createAntigravityDelegationExecutor({ runProcess }),
    createCodexDelegationExecutor({ runProcess }),
  ];
  const discovery = await discoverDelegationProviders({ executors });

  return {
    status: !gitWorktree.available
      ? "UNAVAILABLE"
      : discovery.status,
    gitWorktree,
    providers: discovery.providers,
  };
}
