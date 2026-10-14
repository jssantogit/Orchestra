import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WORKER_REPORT_SCHEMA } from "../../core/delegation/policy.mjs";
import { buildDelegationProcessEnvironment } from "../../runtime/delegation/process-environment.mjs";
import { runBoundedProcess } from "../../runtime/delegation/process-runner.mjs";
import { resolveModelProfile } from "./model-catalog.mjs";

const PROVIDER = "codex";
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_MAX_OUTPUT_BYTES = 64 * 1024;
const PROVIDER_ENV_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "CODEX_HOME",
]);
const REQUIRED_HELP_FLAGS = Object.freeze([
  "--model",
  "--sandbox",
  "--config",
  "--output-schema",
  "--output-last-message",
]);
const REPORT_KEYS = new Set(Object.keys(WORKER_REPORT_SCHEMA.properties));

function processEnvironment() {
  return buildDelegationProcessEnvironment({ providerKeys: PROVIDER_ENV_KEYS });
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

function parseWorkerReport(path) {
  let text;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validateWorkerReport(parsed) ? parsed : null;
}

function promptFor(workerEnvelope) {
  return [
    "You are an external Orchestra worker operating under a bounded read/process-exec envelope.",
    "Do not modify source files. Do not use network tools. Do not delegate work to another agent.",
    "The workspace is disposable: local test/tool writes may occur only as incidental execution artifacts and must not be treated as candidate mutations.",
    "Inspect only the provided workspace and run only local read/test commands needed by the envelope.",
    "Return exactly one JSON object matching the supplied output schema.",
    JSON.stringify(workerEnvelope),
  ].join("\n");
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
    && Number.isInteger(request.limits?.timeoutMs)
    && request.limits.timeoutMs > 0
    && Number.isInteger(request.limits?.maxOutputBytes)
    && request.limits.maxOutputBytes > 0;
}

export function createCodexDelegationExecutor({ runProcess = runBoundedProcess } = {}) {
  if (typeof runProcess !== "function") throw new TypeError("CODEX_DELEGATION_RUNNER_REQUIRED");

  return {
    provider: PROVIDER,

    async discover() {
      try {
        const env = processEnvironment();
        const versionResult = await runProcess({
          command: "codex",
          args: ["--version"],
          timeoutMs: DISCOVERY_TIMEOUT_MS,
          maxOutputBytes: DISCOVERY_MAX_OUTPUT_BYTES,
          env,
        });
        if (versionResult.timedOut
            || versionResult.exitCode !== 0
            || versionResult.stdoutTruncated) return unavailable();

        const helpResult = await runProcess({
          command: "codex",
          args: ["exec", "--help"],
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
            exec: true,
            sandbox: true,
            approvalPolicy: true,
            model: true,
            reasoningEffort: true,
            structuredOutput: true,
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

      const scratch = mkdtempSync(join(tmpdir(), "orchestra-codex-worker-"));
      const schemaPath = join(scratch, "worker-report.schema.json");
      const resultPath = join(scratch, "worker-report.json");
      writeFileSync(schemaPath, `${JSON.stringify(WORKER_REPORT_SCHEMA)}\n`, "utf8");

      let result;
      try {
        result = await runProcess({
          command: "codex",
          args: [
            "exec",
            "--model", profile.model,
            "--sandbox", "workspace-write",
            "--config", "approval_policy=never",
            "--config", `model_reasoning_effort=${profile.reasoningEffort}`,
            "--output-schema", schemaPath,
            "--output-last-message", resultPath,
            "-",
          ],
          cwd: workspace.path,
          input: promptFor(workerEnvelope),
          timeoutMs: request.limits.timeoutMs,
          maxOutputBytes: request.limits.maxOutputBytes,
          env: processEnvironment(),
        });
      } catch (error) {
        rmSync(scratch, { recursive: true, force: true });
        if (error?.code === "PROCESS_SPAWN_FAILED") return failure("PROVIDER_UNAVAILABLE");
        return failure("EXECUTION_FAILED");
      }

      if (result.timedOut) {
        rmSync(scratch, { recursive: true, force: true });
        return failure("EXECUTION_TIMED_OUT", result);
      }
      if (result.exitCode !== 0) {
        rmSync(scratch, { recursive: true, force: true });
        return failure("EXECUTION_FAILED", result);
      }
      if (result.stdoutTruncated || result.stderrTruncated) {
        rmSync(scratch, { recursive: true, force: true });
        return failure("INVALID_RESULT", result);
      }

      const report = parseWorkerReport(resultPath);
      rmSync(scratch, { recursive: true, force: true });
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
