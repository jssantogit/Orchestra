import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { TOOL_OUTPUT_LIMITS } from "../skills/agy-orchestra/routing-policy.mjs";

function getPaths() {
  const cwd = process.cwd();
  const repoRoot = existsSync(resolve(cwd, "packages"))
    ? cwd
    : (existsSync(resolve(cwd, "../packages")) ? resolve(cwd, "..") : cwd);
  return {
    repoRoot,
    stateDir: resolve(repoRoot, ".agents/state"),
    executionsDir: resolve(repoRoot, ".agents/state/executions"),
    artifactsDir: resolve(repoRoot, ".agents/artifacts/outputs"),
  };
}

function enforceExecutionRetention(executionsDir, maxKeep = 50, maxAgeMs = 3600000) {
  try {
    if (!existsSync(executionsDir)) return;
    const entries = readdirSync(executionsDir, { withFileTypes: true });
    const files = [];
    const now = Date.now();

    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith(".json")) {
        const full = resolve(executionsDir, ent.name);
        try {
          const st = statSync(full);
          files.push({ path: full, mtimeMs: st.mtimeMs });
        } catch {}
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isTooOld = (now - file.mtimeMs) > maxAgeMs;
      const isPastLimit = i >= maxKeep;
      if (isTooOld || isPastLimit) {
        try { unlinkSync(file.path); } catch {}
      }
    }
  } catch {}
}

function main() {
  let executionId = "";
  let command = "";
  let conversationId = null;
  let stepIdx = null;
  let agentId = null;
  let taskId = null;
  let toolCallId = null;

  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--exec-id" && i + 1 < args.length) {
        executionId = args[i + 1];
        i++;
      } else if (args[i] === "--b64" && i + 1 < args.length) {
        command = Buffer.from(args[i + 1], "base64").toString("utf-8");
        i++;
      } else if (args[i] === "--cmd" && i + 1 < args.length) {
        command = args.slice(i + 1).join(" ");
        break;
      } else if (args[i] === "--conv-id" && i + 1 < args.length) {
        conversationId = args[i + 1];
        i++;
      } else if (args[i] === "--step-idx" && i + 1 < args.length) {
        stepIdx = args[i + 1];
        i++;
      } else if (args[i] === "--agent-id" && i + 1 < args.length) {
        agentId = args[i + 1];
        i++;
      } else if (args[i] === "--task-id" && i + 1 < args.length) {
        taskId = args[i + 1];
        i++;
      } else if (args[i] === "--tool-call-id" && i + 1 < args.length) {
        toolCallId = args[i + 1];
        i++;
      }
    }

    if (!executionId) {
      executionId = `exec-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 9)}`;
    }

    if (!command) {
      console.error("OUTPUT_GATE_INTERNAL_ERROR: missing command (--cmd or --b64)");
      process.exit(1);
    }
  } catch (err) {
    console.error(`OUTPUT_GATE_INTERNAL_ERROR: ${err.message || String(err)}`);
    process.exit(1);
  }

  const { repoRoot, stateDir, executionsDir, artifactsDir } = getPaths();
  try {
    mkdirSync(executionsDir, { recursive: true });
  } catch {}

  const startTime = Date.now();
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  const child = spawn(command, {
    shell: process.env.SHELL || "/bin/bash",
    stdio: ["inherit", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk);
    stdoutBytes += chunk.length;
  });

  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
    stderrBytes += chunk.length;
  });

  child.on("error", (err) => {
    const durationMs = Date.now() - startTime;
    const execution = {
      executionId,
      command,
      exitCode: 1,
      durationMs,
      timestamp: new Date().toISOString(),
      agentId: agentId || null,
      conversationId: conversationId || null,
      taskId: taskId || null,
      toolCallId: toolCallId || null,
      stepIdx: stepIdx !== null && stepIdx !== "" ? Number(stepIdx) : null,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(String(err)),
      totalBytes: Buffer.byteLength(String(err)),
      totalLines: 1,
      truncated: false,
      artifactPath: null,
      preview: String(err).slice(0, 200),
      error: `OUTPUT_GATE_INTERNAL_ERROR: ${err.message || String(err)}`,
      consumed: false,
    };
    try {
      writeFileSync(resolve(executionsDir, `${executionId}.json`), JSON.stringify(execution, null, 2), "utf-8");
      enforceExecutionRetention(executionsDir);
    } catch {}
    console.error(`OUTPUT_GATE_INTERNAL_ERROR: ${err.message || String(err)}`);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    const durationMs = Date.now() - startTime;
    const exitCode = code !== null ? code : (signal ? 128 + 15 : 1);
    const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf-8");
    const stderrRaw = Buffer.concat(stderrChunks).toString("utf-8");
    const combinedRaw = stdoutRaw + (stderrRaw ? (stdoutRaw ? "\n" : "") + stderrRaw : "");

    const totalBytes = stdoutBytes + stderrBytes;
    const lines = combinedRaw.split("\n");
    const totalLines = lines.length;

    const maxBytes = TOOL_OUTPUT_LIMITS.maxInlineBytes;
    const maxLines = TOOL_OUTPUT_LIMITS.maxInlineLines;
    const previewCount = TOOL_OUTPUT_LIMITS.previewLines;
    const failureExcerptCount = TOOL_OUTPUT_LIMITS.maxFailureExcerpt;

    const isTruncated = totalBytes > maxBytes || totalLines > maxLines;
    let artifactPath = null;
    let finalStdout = stdoutRaw;
    let finalStderr = stderrRaw;

    if (isTruncated) {
      mkdirSync(artifactsDir, { recursive: true });
      const artifactFileName = `output-${Date.now()}-${process.pid}.log`;
      const fullArtifactPath = resolve(artifactsDir, artifactFileName);
      writeFileSync(fullArtifactPath, combinedRaw, "utf-8");
      artifactPath = relative(repoRoot, fullArtifactPath);

      const previewSnippet = lines.slice(0, previewCount).join("\n");
      let failureSnippet = "";
      if (exitCode !== 0) {
        const failLines = lines.slice(-failureExcerptCount);
        failureSnippet = `\nfailure_excerpt (last ${failureExcerptCount} lines):\n${failLines.join("\n")}\n`;
      }

      const packet = [
        `[OUTPUT_TRUNCATED]`,
        `bytes: ${totalBytes}`,
        `lines: ${totalLines}`,
        `raw_artifact: ${artifactPath}`,
        `preview (first ${previewCount} lines):`,
        previewSnippet,
        failureSnippet,
        `recommendation: inspect via filtered query (jq, grep, head/tail) or local summarizer script.`,
      ].filter(Boolean).join("\n");

      finalStdout = packet;
      finalStderr = "";
    }

    const execution = {
      executionId,
      command,
      exitCode,
      durationMs,
      timestamp: new Date().toISOString(),
      agentId: agentId || null,
      conversationId: conversationId || null,
      taskId: taskId || null,
      toolCallId: toolCallId || null,
      stepIdx: stepIdx !== null && stepIdx !== "" ? Number(stepIdx) : null,
      stdoutBytes,
      stderrBytes,
      totalBytes,
      totalLines,
      truncated: isTruncated,
      artifactPath,
      preview: lines.slice(0, 10).join("\n"),
      consumed: false,
    };

    try {
      writeFileSync(resolve(executionsDir, `${executionId}.json`), JSON.stringify(execution, null, 2), "utf-8");
      enforceExecutionRetention(executionsDir);
    } catch {}

    if (finalStdout) process.stdout.write(finalStdout + (finalStdout.endsWith("\n") ? "" : "\n"));
    if (finalStderr) process.stderr.write(finalStderr + (finalStderr.endsWith("\n") ? "" : "\n"));

    process.exit(exitCode);
  });
}

main();
