#!/usr/bin/env node
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const orchestraRoot = resolve(__dirname, "../..");
const fixtureSource = resolve(orchestraRoot, "benchmarks/turn-economy/fixture");
const resultsDir = resolve(orchestraRoot, "benchmarks/turn-economy/results");
const brainDir = join(homedir(), ".gemini/antigravity-cli/brain");

function createTempFixture(tag) {
  const tempProject = mkdtempSync(join(tmpdir(), `orch-probe-${tag}-`));
  cpSync(fixtureSource, tempProject, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: tempProject, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Probe Runner"], { cwd: tempProject, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "probe@orchestra.local"], { cwd: tempProject, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: tempProject, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial probe fixture commit"], { cwd: tempProject, stdio: "ignore" });
  return tempProject;
}

function installAgyRuntime(targetDir) {
  const installScript = join(orchestraRoot, "scripts/install-antigravity.mjs");
  execFileSync(process.execPath, [installScript, targetDir], { stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: targetDir, stdio: "ignore" });
  try {
    execFileSync("git", ["commit", "--allow-empty", "-m", "chore: install antigravity runtime"], { cwd: targetDir, stdio: "ignore" });
  } catch {}
}

export function runAgyProbe({ probeId, name, prompt, timeoutMs = 90000 }) {
  console.log(`\n==================================================`);
  console.log(`RUNNING AGY PROBE: [${probeId}] ${name}`);
  console.log(`Prompt: "${prompt}"`);
  console.log(`==================================================`);

  const tempDir = createTempFixture(probeId);
  installAgyRuntime(tempDir);

  const startTime = Date.now();
  const agyExe = process.platform === "win32" ? "agy.exe" : "agy";
  const args = [
    "--add-dir",
    tempDir,
    "-p",
    prompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
  ];

  const env = {
    ...process.env,
    BENCHMARK_PROBE_ID: probeId,
  };

  const res = spawnSync(agyExe, args, {
    cwd: tempDir,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });

  const durationMs = Date.now() - startTime;
  const stdout = res.stdout || "";
  const stderr = res.stderr || "";

  let agyOutput = null;
  let convId = null;
  try {
    const trimmed = stdout.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*"conversation_id"[\s\S]*\}/);
    if (jsonMatch) {
      agyOutput = JSON.parse(jsonMatch[0]);
      convId = agyOutput.conversation_id;
    }
  } catch (err) {
    console.warn("Failed to parse agy output JSON:", err.message);
  }

  // Load transcript if convId is known
  let steps = [];
  let modelTurns = [];
  let toolCallDistribution = { 0: 0, 1: 0, 2: 0, "3+": 0 };
  let maxToolsInSingleTurn = 0;
  let multiToolObserved = false;
  let toolsPerTurnList = [];

  if (convId) {
    const transcriptPath = join(brainDir, convId, ".system_generated/logs/transcript.jsonl");
    if (existsSync(transcriptPath)) {
      try {
        const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
        steps = lines.map(l => JSON.parse(l));

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (step.type === "PLANNER_RESPONSE" && step.source === "MODEL") {
            const tcs = step.tool_calls || [];
            const count = tcs.length;
            toolsPerTurnList.push(count);
            if (count === 0) toolCallDistribution[0]++;
            else if (count === 1) toolCallDistribution[1]++;
            else if (count === 2) toolCallDistribution[2]++;
            else toolCallDistribution["3+"]++;

            if (count > maxToolsInSingleTurn) {
              maxToolsInSingleTurn = count;
            }
            if (count >= 2) {
              multiToolObserved = true;
            }

            modelTurns.push({
              step_index: step.step_index ?? i,
              tool_calls_count: count,
              tools: tcs.map(tc => tc.name || tc.function?.name || "unknown"),
              args: tcs.map(tc => tc.args || tc.parameters || {}),
            });
          }
        }
      } catch (err) {
        console.warn("Failed to parse transcript:", err.message);
      }
    }
  }

  // Load active-state.json and telemetry events
  let state = {};
  const statePath = join(tempDir, ".agents/state/active-state.json");
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {}
  }

  const result = {
    probeId,
    name,
    prompt,
    durationMs,
    conversationId: convId,
    status: agyOutput?.status || (res.status === 0 ? "SUCCESS" : "FAILED"),
    exitCode: res.status,
    totalSteps: steps.length,
    modelTurnsCount: modelTurns.length,
    modelTurns,
    toolsPerTurnList,
    toolCallDistribution,
    maxToolsInSingleTurn,
    multiToolObserved,
    totalToolCallsReported: state.tool_calls_total || state.tool_calls || 0,
    subagentsCount: state.subagent_invocations || 0,
    workerInvocations: state.worker_invocations || 0,
    reviewerInvocations: state.reviewer_invocations || 0,
    usage: agyOutput?.usage || null,
    stdoutSample: stdout.slice(0, 500),
    stderrSample: stderr.slice(0, 500),
  };

  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}

  return result;
}
