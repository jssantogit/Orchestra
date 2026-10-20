import { spawn, spawnSync } from "node:child_process";
import { withResourceAdmission } from '../resources/governor.mjs';
import { attachWindowsJob } from '../resources/windows-job.mjs';
import { readDelegatedProcessGroupStatus } from './v2-process-group-probe.mjs';

const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const IS_WINDOWS = process.platform === "win32";

function fail(code, cause = undefined) {
  const error = new Error(code);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function validateInput({ command, args, timeoutMs, maxOutputBytes, env }) {
  if (typeof command !== "string" || !command.trim()) fail("PROCESS_COMMAND_INVALID");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail("PROCESS_ARGS_INVALID");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) fail("PROCESS_LIMITS_INVALID");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_CAPTURE_BYTES) fail("PROCESS_LIMITS_INVALID");
  if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env))) fail("PROCESS_ENV_INVALID");
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
      // Fall through to the direct child kill below.
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through to the direct child kill below.
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // The close/error path remains authoritative.
  }
}

export async function runBoundedProcess(input = {}) {
  validateInput({ command: input.command, args: input.args ?? [], timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes, env: input.env });
  const result = await withResourceAdmission({ governor: input.resourceGovernor, home: input.orchestraHome, signal: input.signal, deadlineAt: input.deadlineAt }, async (admission) => {
    if (admission.activeChildren >= admission.workers) fail('RESOURCE_BUDGET_UNAVAILABLE');
    const check = admission.governor.recheck(admission.leaseId);
    if (!check.ok) fail(check.reason);
    admission.activeChildren++;
    admission.spawned = true;
    let containment;
    let pid;
    try {
      const result = await runAdmittedProcess({ ...input, resourceCheck: () => admission.governor.recheck(admission.leaseId), onSpawn: async (observed) => {
        pid = observed.pid;
        if (IS_WINDOWS) containment = attachWindowsJob(pid, Math.floor(admission.bytes / admission.workers));
        if (input.onSpawn) await input.onSpawn(observed);
      } });
      if (result.resourcePressure) fail('RESOURCE_PRESSURE');
      if (result.timedOut || result.signal !== null) admission.uncertain = true;
      if (IS_WINDOWS) {
        const job = containment.inspect();
        if (job.activeProcesses !== 0) {
          admission.uncertain = true;
          fail('RESOURCE_PROCESS_TREE_UNVERIFIED');
        }
        result.resourceUsage = job;
      } else if (readDelegatedProcessGroupStatus(pid) !== 'ABSENT') admission.uncertain = true;
      return result;
    } catch (error) {
      admission.uncertain = true;
      throw error;
    } finally {
      if (containment) containment.close();
      admission.activeChildren--;
    }
  });
  if (result?.status === 'DEFERRED') fail(result.reason);
  return result;
}

async function runAdmittedProcess({
  command,
  args = [],
  cwd = process.cwd(),
  input = null,
  timeoutMs,
  maxOutputBytes,
  env = undefined,
  onSpawn = null,
  onExit = null,
  resourceCheck,
} = {}) {
  if (onSpawn !== null && typeof onSpawn !== "function") fail("PROCESS_SPAWN_OBSERVER_INVALID");
  if (onExit !== null && typeof onExit !== "function") fail("PROCESS_EXIT_OBSERVER_INVALID");
  validateInput({ command, args, timeoutMs, maxOutputBytes, env });
  if (input !== null && input !== undefined && typeof input !== "string" && !Buffer.isBuffer(input)) {
    fail("PROCESS_INPUT_INVALID");
  }

  const started = process.hrtime.bigint();
  const stdout = capture(maxOutputBytes);
  const stderr = capture(maxOutputBytes);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env === undefined ? process.env : env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: !IS_WINDOWS,
      });
    } catch (cause) {
      const error = new Error("PROCESS_SPAWN_FAILED");
      error.code = "PROCESS_SPAWN_FAILED";
      error.cause = cause;
      reject(error);
      return;
    }

    let settled = false;
    let timedOut = false;
    let resourcePressure = false;
    let spawnProofFailure = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    timer.unref?.();
    const resourceTimer = setInterval(() => {
      let check;
      try { check = resourceCheck?.(); } catch { check = null; }
      if (check?.ok !== true) {
        resourcePressure = true;
        clearInterval(resourceTimer);
        killProcessTree(child);
      }
    }, 1000);
    resourceTimer.unref?.();

    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.stdin.on("error", () => {});

    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(resourceTimer);
      const error = new Error("PROCESS_SPAWN_FAILED");
      error.code = "PROCESS_SPAWN_FAILED";
      error.cause = cause;
      reject(error);
    });

    // Do not send the provider's task envelope until the native parent has
    // durably observed this exact spawned PID. On observer failure, terminate
    // the process tree and never return successful provider output. Child
    // processes that act solely from argv can still start before observation,
    // so this is not a proof that no side effect occurred.
    let observerTimeout = null;
    const observer = onSpawn === null ? Promise.resolve() : Promise.race([
      Promise.resolve().then(() => onSpawn({ pid: child.pid })),
      new Promise((_, rejectObserver) => {
        observerTimeout = setTimeout(
          () => rejectObserver(new Error("PROCESS_SPAWN_PROOF_TIMEOUT")),
          Math.min(timeoutMs, 15_000),
        );
        observerTimeout.unref?.();
      }),
    ]);
    const spawnProof = observer.then(
      () => {
        if (!settled) {
          if (input === null || input === undefined) child.stdin.end();
          else child.stdin.end(input);
        }
      },
      (cause) => {
        spawnProofFailure = cause;
        killProcessTree(child);
      },
    ).finally(() => {
      if (observerTimeout) clearTimeout(observerTimeout);
    });

    child.once("close", async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(resourceTimer);
      await spawnProof;
      if (spawnProofFailure) {
        const error = new Error("PROCESS_SPAWN_PROOF_FAILED");
        error.code = "PROCESS_SPAWN_PROOF_FAILED";
        error.cause = spawnProofFailure;
        reject(error);
        return;
      }
      if (onExit !== null) {
        // This callback receives facts from this exact child's close event,
        // never values reported by the worker. A failed Home persistence
        // prevents an apparently successful provider result.
        let timeout;
        try {
          await Promise.race([
            Promise.resolve().then(() => onExit({
              pid: child.pid, exitCode,
              signal: signal ?? null, timedOut,
            })),
            new Promise((_, rejectClose) => {
              timeout = setTimeout(() => rejectClose(
                new Error("PROCESS_EXIT_PROOF_TIMEOUT"),
              ), Math.min(timeoutMs, 15_000));
            }),
          ]);
        } catch (cause) {
          const error = new Error("PROCESS_EXIT_PROOF_FAILED");
          error.code = "PROCESS_EXIT_PROOF_FAILED";
          error.cause = cause;
          reject(error);
          return;
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      const ended = process.hrtime.bigint();
      resolve({
        exitCode,
        signal: signal ?? null,
        durationMs: Math.max(0, Number((ended - started) / 1_000_000n)),
        stdout: stdout.value(),
        stderr: stderr.value(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        resourcePressure,
      });
    });
  });
}
