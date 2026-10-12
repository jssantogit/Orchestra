import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createRuntimeEvent } from "../skills/orchestra/core/events/runtime-event.mjs";
import { normalizeToolEvent } from "../skills/orchestra/provider/antigravity/adapter/tool-event.mjs";
import { attachProviderTelemetryReference } from "../skills/orchestra/provider/antigravity/adapter/telemetry.mjs";

const legacyHook = resolve(dirname(fileURLToPath(import.meta.url)), "post-tool-telemetry-legacy.mjs");

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function parseWorkspacePath(value) {
  if (typeof value !== "string") return "";
  if (value.startsWith("file://")) {
    try { return fileURLToPath(value); } catch { return value.replace(/^file:\/\/\/?/, ""); }
  }
  return value;
}

function repoRootFrom(payload = {}) {
  const raw = (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0])
    || (Array.isArray(payload.workspaceUris) && payload.workspaceUris[0])
    || payload.cwd
    || null;
  if (raw) return resolve(parseWorkspacePath(raw));
  const cwd = process.cwd();
  if (basename(cwd) === ".agents") return resolve(cwd, "..");
  if (existsSync(resolve(cwd, ".agents"))) return cwd;
  if (existsSync(resolve(cwd, "../.agents"))) return resolve(cwd, "..");
  return cwd;
}

function recordCanonicalEvent(input) {
  try {
    const payload = JSON.parse(input || "{}");
    const repoRoot = repoRootFrom(payload);
    const active = readJson(resolve(repoRoot, ".agents/state/active-state.json"), {}) || {};
    const lease = readJson(resolve(repoRoot, ".orchestra/state/work-lease.json"), {}) || {};
    const normalized = normalizeToolEvent({ ...payload, eventType: payload.eventType || "PostToolUse" });
    if (normalized.eventType === "UNKNOWN") return;
    const generation = Number.isInteger(lease.generation)
      ? lease.generation
      : (Number.isInteger(active.candidateGeneration) ? active.candidateGeneration : 0);
    const event = createRuntimeEvent({
      type: normalized.eventType,
      generation,
      taskId: active.taskId || active.taskKey || null,
      actor: { provider: "antigravity", actorIdHash: normalized.factualIds.actorIdHash },
    });
    let record = { event };
    try { record = attachProviderTelemetryReference(event, payload); } catch {}
    const path = resolve(repoRoot, ".agents/telemetry/runtime-events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {}
}

function main() {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch {}
  recordCanonicalEvent(input);
  const result = spawnSync(process.execPath, [legacyHook], {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.status ?? (result.error ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
