import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createWorkAuthority } from "../../authority/work-authority.mjs";
import { createOperationHeartbeatService } from "../../liveness/operation-heartbeat-service.mjs";
import { createHostProcessIdentityReader, createLocalProcessOwnerProbe } from "../../liveness/local-process-probe.mjs";
import { createOperationLivenessService } from "../../liveness/operation-liveness-service.mjs";
import { createProviderEventProbe } from "../../liveness/provider-event-liveness.mjs";
import { createRuntimeOwnerStore } from "../../liveness/runtime-owner-store.mjs";

const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const IS_WINDOWS = process.platform === "win32";

function fail(code, cause = undefined) {
  const error = new Error(code);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function validateInput({ command, args, cwd, timeoutMs, maxOutputBytes, env }) {
  if (typeof command !== "string" || !command.trim()) throw fail("PROCESS_COMMAND_INVALID");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw fail("PROCESS_ARGS_INVALID");
  if (typeof cwd !== "string" || cwd.length === 0) throw fail("PROCESS_CWD_INVALID");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS
      || !Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_CAPTURE_BYTES) {
    throw fail("PROCESS_LIMITS_INVALID");
  }
  if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env))) {
    throw fail("PROCESS_ENV_INVALID");
  }
}

function capture(maxOutputBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes >= maxOutputBytes) {
        if (buffer.length > 0) truncated = true;
        return;
      }
      const remaining = maxOutputBytes - bytes;
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        return;
      }
      chunks.push(buffer);
      bytes += buffer.length;
    },
    value() {
      return Buffer.concat(chunks, bytes).toString("utf8");
    },
    get truncated() {
      return truncated;
    },
  };
}

function killProcessTree(child) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (IS_WINDOWS) {
    try {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (result.status === 0) return;
    } catch {
      // Fall through to direct-child termination.
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through to direct-child termination.
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // The close event remains authoritative.
  }
}

function addMilliseconds(timestamp, durationMs) {
  return new Date(Date.parse(timestamp) + durationMs).toISOString();
}

function tokenHash(token) {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function processStartIdentity(value) {
  return value?.status === "PRESENT"
    && typeof value.processIdentity === "string"
    && value.processIdentity.length > 0
    ? value.processIdentity
    : null;
}

export function createAntigravityProcessExecution({
  registry,
  projectId,
  expectedWorkId,
  expectedGeneration,
  observedInstructionEpoch,
  actor,
  workspaceRef,
  now = () => new Date().toISOString(),
  readProcessIdentity = createHostProcessIdentityReader(),
  spawnImpl = spawn,
  heartbeatIntervalMs = 10_000,
} = {}) {
  if (!registry?.state?.operations || typeof registry.state.operations.begin !== "function"
      || typeof registry.resolveWorkspace !== "function") {
    throw new TypeError("global operation registry is required");
  }
  if (typeof registry.paths?.home !== "string" || registry.paths.home.length === 0) {
    throw new TypeError("global registry home is required");
  }
  if (typeof projectId !== "string" || projectId.length === 0
      || typeof expectedWorkId !== "string" || expectedWorkId.length === 0
      || !Number.isInteger(expectedGeneration) || expectedGeneration < 0
      || !Number.isInteger(observedInstructionEpoch) || observedInstructionEpoch < 0
      || typeof workspaceRef !== "string" || workspaceRef.length === 0) {
    throw new TypeError("global process authority tuple is required");
  }
  if (typeof now !== "function" || typeof readProcessIdentity !== "function"
      || typeof spawnImpl !== "function" || !Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new TypeError("process execution dependencies are invalid");
  }

  const runtimeOwnerStore = createRuntimeOwnerStore({ rootDir: join(registry.paths.home, "runtime-owners") });
  const ownerProbe = createLocalProcessOwnerProbe({ readProcessIdentity, now });
  const operationLiveness = createOperationLivenessService({
    runtimeOwnerStore,
    ownerProbe,
    providerEventProbe: createProviderEventProbe({ now }),
    now,
  });
  const authority = createWorkAuthority({ state: registry.state, operationLiveness });
  const heartbeatService = createOperationHeartbeatService({
    state: registry.state,
    runtimeOwnerStore,
  });

  async function runProcess({ command, args = [], cwd, timeoutMs, maxOutputBytes, env = undefined } = {}) {
    validateInput({ command, args, cwd, timeoutMs, maxOutputBytes, env });
    let resolvedProject;
    try {
      resolvedProject = await registry.resolveWorkspace(cwd);
    } catch {
      resolvedProject = null;
    }
    const project = registry.state.projects.inspect(projectId);
    if (!resolvedProject || resolvedProject.projectId !== projectId
        || !project || project.workspace.canonicalRoot !== workspaceRef) {
      throw fail("ANTIGRAVITY_PROCESS_WORKSPACE_PROJECT_MISMATCH");
    }

    const authorization = await authority.authorize({
      projectId,
      expectedWorkId,
      expectedGeneration,
      actor,
      observedInstructionEpoch,
      capability: "WORKSPACE_EDIT",
      workspaceRef,
    });
    if (!authorization.allowed) throw fail(authorization.reason || "WORK_AUTHORITY_DENIED");

    const startedClock = process.hrtime.bigint();
    const stdout = capture(maxOutputBytes);
    const stderr = capture(maxOutputBytes);
    const startedAt = now();
    const operationId = `op_${randomUUID()}`;
    const runtimeOwnerId = `runtime-owner:${operationId}`;
    const ownerToken = randomUUID();
    const operation = {
      schema: "orchestra.operation.v2",
      operationId,
      projectId,
      workId: expectedWorkId,
      generation: expectedGeneration,
      kind: "DIRECT_MUTATION",
      actorRef: actor.subjectHash,
      capabilities: ["WORKSPACE_EDIT"],
      workflowState: "RUNNING",
      liveness: "LIVE",
      startedAt,
      heartbeatAt: startedAt,
      deadlineAt: addMilliseconds(startedAt, timeoutMs),
      runtimeOwnerRef: runtimeOwnerId,
      workspaceRef,
      resultRef: null,
    };
    const began = registry.state.operations.begin({ expectedGeneration, operation });
    if (!began.ok) throw fail(began.reason || "OPERATION_BEGIN_FAILED");

    async function terminalizeFailure() {
      const current = registry.state.operations.inspect(operationId);
      if (!current || current.liveness === "TERMINAL") return;
      const terminal = registry.state.operations.terminalize({
        operationId,
        workflowState: "FAILED",
        resultRef: `process-result:failed:${operationId}`,
        expectedHeartbeatAt: current.heartbeatAt,
      });
      if (!terminal.ok) throw fail(terminal.reason || "PROCESS_OPERATION_TERMINALIZATION_FAILED");
    }

    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        env: env === undefined ? process.env : env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: !IS_WINDOWS,
      });
    } catch (cause) {
      await terminalizeFailure();
      throw fail("PROCESS_SPAWN_FAILED", cause);
    }
    if (!child || typeof child.once !== "function") {
      await terminalizeFailure();
      throw fail("PROCESS_SPAWN_FAILED");
    }
    let closeResult = null;
    const closed = new Promise((resolve, reject) => {
      child.once("error", (cause) => {
        reject(fail("PROCESS_SPAWN_FAILED", cause));
      });
      child.once("close", (exitCode, signal) => {
        closeResult = { exitCode, signal: signal ?? null };
        resolve(closeResult);
      });
    });
    closed.catch(() => {});

    child.stdout?.on("data", (chunk) => stdout.append(chunk));
    child.stderr?.on("data", (chunk) => stderr.append(chunk));
    child.stdin?.on("error", () => {});

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    timeout.unref?.();
    child.stdin?.end();

    let heartbeatTimer;
    let heartbeatInFlight = Promise.resolve();
    let heartbeatFailed = false;
    try {
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        await closed.catch(() => {});
        throw fail("PROCESS_SPAWN_FAILED");
      }
      let processFact;
      try {
        processFact = await readProcessIdentity(child.pid);
      } catch {
        processFact = null;
      }
      const startIdentity = processStartIdentity(processFact);
      if (!startIdentity) throw fail("PROCESS_OWNER_IDENTITY_UNAVAILABLE");

      const owner = {
        schema: "orchestra.runtime-owner.v2",
        runtimeOwnerId,
        operationId,
        kind: "LOCAL_PROCESS",
        registeredAt: startedAt,
        process: { pid: child.pid, startIdentity },
        proof: { tokenHash: tokenHash(ownerToken) },
      };
      const ownerResult = await runtimeOwnerStore.register(owner);
      if (!ownerResult.ok) throw fail(ownerResult.reason || "RUNTIME_OWNER_REGISTRATION_FAILED");

      heartbeatTimer = setInterval(() => {
        if (heartbeatFailed || closeResult) return;
        heartbeatInFlight = heartbeatInFlight.then(async () => {
          if (heartbeatFailed || closeResult) return;
          const beat = await heartbeatService.heartbeat({
            operationId,
            ownerToken,
            heartbeatAt: now(),
          });
          if (!beat.ok) {
            heartbeatFailed = true;
            killProcessTree(child);
          }
        }).catch(() => {
          heartbeatFailed = true;
          killProcessTree(child);
        });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    } catch (error) {
      clearTimeout(timeout);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      killProcessTree(child);
      await closed.catch(() => {});
      await heartbeatInFlight;
      await terminalizeFailure();
      throw error;
    }

    let processResult;
    try {
      processResult = await closed;
    } catch (error) {
      clearTimeout(timeout);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await heartbeatInFlight;
      await terminalizeFailure();
      throw error;
    }

    clearTimeout(timeout);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await heartbeatInFlight;
    const workflowState = !timedOut && processResult.exitCode === 0 && !stdout.truncated
      ? "SUCCEEDED"
      : "FAILED";
    const currentOperation = registry.state.operations.inspect(operationId);
    if (!currentOperation || currentOperation.liveness === "TERMINAL") {
      throw fail("PROCESS_OPERATION_TERMINALIZATION_FAILED");
    }
    const terminal = registry.state.operations.terminalize({
      operationId,
      workflowState,
      resultRef: `process-result:${workflowState.toLowerCase()}:${operationId}`,
      expectedHeartbeatAt: currentOperation.heartbeatAt,
    });
    if (!terminal.ok) throw fail(terminal.reason || "PROCESS_OPERATION_TERMINALIZATION_FAILED");

    const endedClock = process.hrtime.bigint();
    return {
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      durationMs: Math.max(0, Number((endedClock - startedClock) / 1_000_000n)),
      stdout: stdout.value(),
      stderr: stderr.value(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut,
    };
  }

  return Object.freeze({ runProcess });
}
