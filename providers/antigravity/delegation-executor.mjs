import { WORKER_REPORT_SCHEMA } from "../../core/delegation/policy.mjs";
import { buildDelegationProcessEnvironment } from "../../runtime/delegation/process-environment.mjs";
import { runBoundedProcess } from "../../runtime/delegation/process-runner.mjs";
import { resolveModelProfile } from "./model-catalog.mjs";

const PROVIDER = "antigravity";
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_MAX_OUTPUT_BYTES = 64 * 1024;
const PROVIDER_ENV_KEYS = Object.freeze([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_GENAI_USE_VERTEXAI",
]);
const REQUIRED_HELP_FLAGS = Object.freeze([
  "--print",
  "--print-timeout",
  "--sandbox",
  "--model",
]);
const REPORT_KEYS = new Set(Object.keys(WORKER_REPORT_SCHEMA.properties));

function processEnvironment(extra = {}) {
  return buildDelegationProcessEnvironment({
    providerKeys: PROVIDER_ENV_KEYS,
    extra,
  });
}

function unavailable() {
  return { available: false, provider: PROVIDER, reason: "PROVIDER_UNAVAILABLE" };
}

function executionFacts(result = {}) {
  return {
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    durationMs: Number.isInteger(result.durationMs) && result.durationMs >= 0
      ? result.durationMs
      : 0,
  };
}

function failure(reason, result = {}) {
  return {
    ok: false,
    provider: PROVIDER,
    reason,
    execution: executionFacts(result),
  };
}

function boundedString(value, schema) {
  if (typeof value !== "string") return false;
  if (schema.minLength !== undefined && value.length < schema.minLength) return false;
  if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
  return true;
}

function boundedStringArray(value, schema) {
  if (!Array.isArray(value)) return false;
  if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
  if (schema.uniqueItems && new Set(value).size !== value.length) return false;
  return value.every((entry) => boundedString(entry, schema.items));
}

function validateWorkerReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return false;
  const keys = Object.keys(report);
  if (keys.length !== REPORT_KEYS.size || keys.some((key) => !REPORT_KEYS.has(key))) return false;

  const properties = WORKER_REPORT_SCHEMA.properties;
  return boundedString(report.summary, properties.summary)
    && boundedStringArray(report.findings, properties.findings)
    && boundedStringArray(report.evidenceRefs, properties.evidenceRefs);
}

function parseWorkerReport(stdout) {
  if (typeof stdout !== "string") return null;
  const text = stdout.trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validateWorkerReport(parsed) ? parsed : null;
}

function isImplementationRequest(request) {
  return request?.schema === "orchestra.delegation-request.v2";
}

function promptFor(request, workerEnvelope) {
  if (!isImplementationRequest(request)) {
    return [
      "You are an external Orchestra worker operating under a bounded read/process-exec envelope.",
      "Do not modify files. Do not use network tools. Do not delegate work to another agent.",
      "Inspect only the provided workspace and run only local read/test commands needed by the envelope.",
      "Return exactly one JSON object matching the output contract. Do not wrap it in Markdown or prose.",
      JSON.stringify(workerEnvelope),
    ].join("\n");
  }

  return [
    "You are an external Orchestra implementation worker operating under bounded WORKSPACE_ONLY mutation authority.",
    "Modify files only within mutationScope.allowedPaths and never within mutationScope.forbiddenPaths.",
    "Do not use network tools. Do not delegate work to another agent.",
    "Do not create commits, change branches or HEAD, edit refs/remotes/Git config/hooks, or otherwise mutate Git history or metadata.",
    "Operate only inside the provided isolated workspace and run only local commands needed by the envelope.",
    "Return exactly one JSON object matching the output contract. Do not wrap it in Markdown or prose.",
    JSON.stringify(workerEnvelope),
  ].join("\n");
}

function printTimeoutValue(timeoutMs) {
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
}

function validWorkerGitEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.GIT_CONFIG_NOSYSTEM !== "1"
      || typeof value.GIT_CONFIG_GLOBAL !== "string" || !value.GIT_CONFIG_GLOBAL
      || value.GIT_TERMINAL_PROMPT !== "0"
      || value.GIT_PROTOCOL_FROM_USER !== "0"
      || value.GIT_ALLOW_PROTOCOL !== "") return false;

  const count = Number.parseInt(value.GIT_CONFIG_COUNT, 10);
  if (!Number.isInteger(count) || count < 2) return false;
  let hooksDenied = false;
  let protocolsDenied = false;
  for (let index = 0; index < count; index += 1) {
    const key = value[`GIT_CONFIG_KEY_${index}`];
    const configured = value[`GIT_CONFIG_VALUE_${index}`];
    if (typeof key !== "string" || typeof configured !== "string") return false;
    if (key === "core.hooksPath" && configured) hooksDenied = true;
    if (key === "protocol.allow" && configured === "never") protocolsDenied = true;
  }
  return hooksDenied && protocolsDenied;
}

function validExecutionInput(request, workerEnvelope, workspace) {
  return request
    && request.target?.provider === PROVIDER
    && typeof request.target.logicalRole === "string"
    && workerEnvelope
    && typeof workerEnvelope === "object"
    && !Array.isArray(workerEnvelope)
    && workspace
    && typeof workspace.path === "string"
    && workspace.path.length > 0
    && (!isImplementationRequest(request) || validWorkerGitEnvironment(workspace.workerGitEnv))
    && Number.isInteger(request.limits?.timeoutMs)
    && request.limits.timeoutMs > 0
    && Number.isInteger(request.limits?.maxOutputBytes)
    && request.limits.maxOutputBytes > 0;
}

export function createAntigravityDelegationExecutor({ runProcess = runBoundedProcess } = {}) {
  if (typeof runProcess !== "function") {
    throw new TypeError("ANTIGRAVITY_DELEGATION_RUNNER_REQUIRED");
  }

  return {
    provider: PROVIDER,

    async discover() {
      try {
        const env = processEnvironment();
        const versionResult = await runProcess({
          command: "agy",
          args: ["--version"],
          timeoutMs: DISCOVERY_TIMEOUT_MS,
          maxOutputBytes: DISCOVERY_MAX_OUTPUT_BYTES,
          env,
        });
        if (versionResult.timedOut
            || versionResult.exitCode !== 0
            || versionResult.stdoutTruncated) return unavailable();

        const helpResult = await runProcess({
          command: "agy",
          args: ["--help"],
          timeoutMs: DISCOVERY_TIMEOUT_MS,
          maxOutputBytes: DISCOVERY_MAX_OUTPUT_BYTES,
          env,
        });
        if (helpResult.timedOut
            || helpResult.exitCode !== 0
            || helpResult.stdoutTruncated) return unavailable();

        const help = String(helpResult.stdout ?? "");
        if (!REQUIRED_HELP_FLAGS.every((flag) => help.includes(flag))) return unavailable();

        const version = String(versionResult.stdout ?? "").trim();
        if (!version) return unavailable();

        return {
          available: true,
          provider: PROVIDER,
          version,
          capabilities: {
            print: true,
            printTimeout: true,
            sandbox: true,
            model: true,
            implementation: help.includes("--mode"),
          },
        };
      } catch {
        return unavailable();
      }
    },

    async execute({ request, workerEnvelope, workspace } = {}) {
      if (!validExecutionInput(request, workerEnvelope, workspace)) {
        return failure("CAPABILITY_DENIED");
      }

      let profile;
      try {
        profile = resolveModelProfile(request.target.logicalRole);
      } catch {
        return failure("CAPABILITY_DENIED");
      }

      let result;
      try {
        result = await runProcess({
          command: "agy",
          args: [
            "--sandbox",
            ...(isImplementationRequest(request) ? ["--mode=accept-edits"] : []),
            "--model",
            profile.model,
            "--print-timeout",
            printTimeoutValue(request.limits.timeoutMs),
            "--print",
            promptFor(request, workerEnvelope),
          ],
          cwd: workspace.path,
          timeoutMs: request.limits.timeoutMs,
          maxOutputBytes: request.limits.maxOutputBytes,
          env: processEnvironment(workspace.workerGitEnv ?? {}),
        });
      } catch (error) {
        if (error?.code === "PROCESS_SPAWN_FAILED") {
          return failure("PROVIDER_UNAVAILABLE");
        }
        return failure("EXECUTION_FAILED");
      }

      if (result.timedOut) return failure("EXECUTION_TIMED_OUT", result);
      if (result.exitCode !== 0) return failure("EXECUTION_FAILED", result);
      if (result.stdoutTruncated) return failure("INVALID_RESULT", result);

      const report = parseWorkerReport(result.stdout);
      if (!report) return failure("INVALID_RESULT", result);

      return {
        ok: true,
        provider: PROVIDER,
        report,
        execution: executionFacts(result),
      };
    },
  };
}
