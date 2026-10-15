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

function boundedProcessResult(result) {
  return result
    && result.timedOut !== true
    && result.stdoutTruncated !== true
    && result.stderrTruncated !== true;
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
      available: boundedProcessResult(result) && result.exitCode === 0,
    };
  } catch {
    return { available: false };
  }
}

async function inspectGitClone(runProcess) {
  try {
    const result = await runProcess({
      command: "git",
      args: ["clone", "-h"],
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      maxOutputBytes: DISCOVERY_MAX_OUTPUT_BYTES,
    });
    const output = `${result?.stdout || ""}\n${result?.stderr || ""}`;
    const noHardlinks = boundedProcessResult(result) && /(?:^|\s)--no-hardlinks(?:\s|$)/m.test(output);
    return {
      available: noHardlinks,
      noHardlinks,
    };
  } catch {
    return { available: false, noHardlinks: false };
  }
}

function providerModeStatus(providers, capability = null) {
  if (!Array.isArray(providers) || providers.length === 0) return "UNAVAILABLE";
  const availableCount = providers.filter((provider) => provider?.available === true
    && (capability === null || provider.capabilities?.[capability] === true)).length;
  if (availableCount === providers.length) return "READY";
  if (availableCount === 0) return "UNAVAILABLE";
  return "DEGRADED";
}

function parallelImplementationStatus(providers) {
  if (!Array.isArray(providers) || providers.length !== 2) return "UNAVAILABLE";
  return providers.every((provider) => provider?.available === true
    && provider.capabilities?.implementation === true)
    ? "READY"
    : "UNAVAILABLE";
}

function buildModes({ discoveryStatus, gitWorktree, gitClone, providers }) {
  return {
    review: {
      status: gitWorktree.available ? discoveryStatus : "UNAVAILABLE",
      isolation: "EPHEMERAL_WORKTREE",
    },
    implementation: {
      status: gitClone.available ? providerModeStatus(providers, "implementation") : "UNAVAILABLE",
      isolation: "EPHEMERAL_CLONE",
      artifactLifecycle: "CONTROL_OWNED",
    },
    parallelImplementation: {
      status: gitClone.available ? parallelImplementationStatus(providers) : "UNAVAILABLE",
      isolation: "EPHEMERAL_CLONE",
      memberCount: 2,
      artifactLifecycle: "CONTROL_OWNED_COMPOSITE",
    },
  };
}

export async function inspectDelegationCapabilities({ runProcess = runBoundedProcess } = {}) {
  if (typeof runProcess !== "function") {
    throw new TypeError("DELEGATION_DISCOVERY_RUNNER_REQUIRED");
  }

  const gitWorktree = await inspectGitWorktree(runProcess);
  const gitClone = await inspectGitClone(runProcess);
  const executors = [
    createAntigravityDelegationExecutor({ runProcess }),
    createCodexDelegationExecutor({ runProcess }),
  ];
  const discovery = await discoverDelegationProviders({ executors });
  const modes = buildModes({
    discoveryStatus: discovery.status,
    gitWorktree,
    gitClone,
    providers: discovery.providers,
  });

  return {
    status: modes.review.status,
    gitWorktree,
    gitClone,
    modes,
    providers: discovery.providers,
  };
}
