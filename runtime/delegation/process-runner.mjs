import { spawn } from "node:child_process";

const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

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

export async function runBoundedProcess({
  command,
  args = [],
  cwd = process.cwd(),
  input = null,
  timeoutMs,
  maxOutputBytes,
  env = undefined,
} = {}) {
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
        env: env === undefined ? process.env : { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
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
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The close/error path below remains authoritative.
      }
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.stdin.on("error", () => {});

    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = new Error("PROCESS_SPAWN_FAILED");
      error.code = "PROCESS_SPAWN_FAILED";
      error.cause = cause;
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      });
    });

    if (input === null || input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}
