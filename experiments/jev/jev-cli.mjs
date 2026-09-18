#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JevClient, createFakeJevClient } from "./client.mjs";
import { buildCatalog } from "./catalog-builder.mjs";
import { runArtifactRankingShadow, readShadowTelemetry } from "./shadow-runner.mjs";
import { annotateDreamDirectory } from "./dream-analyzer.mjs";
import {
  createProjectEvaluationReport,
  createLocalApproval,
  loadStoredEvaluation,
  writeEvaluationReport,
  writeLocalApproval,
} from "./activation-gate.mjs";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) { out._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
function json(path) { return JSON.parse(readFileSync(resolve(path), "utf8")); }
function print(value) { console.log(JSON.stringify(value, null, 2)); }
function usage() {
  console.log(`Orchestra Jev Semantic Lab

catalog  --repo <path>
shadow   --repo <path> --goal <text> [--live] [--task-category lookup]
dream    --repo <path> [--live]
evaluate --repo <path>
approve  --repo <path> [--report <evaluation.json>] [--note text]

Live calls require TYPESAFE_API_KEY.
No command mutates provider transcripts or Orchestra evidence.`);
}

const parsed = args(process.argv.slice(2));
const command = parsed._[0];
if (!command || command === "help" || parsed.help) { usage(); process.exit(0); }
if (!parsed.repo) throw new Error("--repo is required");
const repo = resolve(parsed.repo);

if (command === "catalog") {
  print(buildCatalog(repo));
} else if (command === "shadow") {
  if (!parsed.goal) throw new Error("--goal is required");
  const live = parsed.live === true;
  const client = live ? new JevClient() : createFakeJevClient(({ name }) => {
    if (name.startsWith("useful__")) return 0.65;
    if (name.startsWith("future__")) return 0.6;
    if (name.startsWith("duplicate__")) return 0.25;
    return 0.5;
  });
  const result = await runArtifactRankingShadow({
    projectRoot: repo,
    client,
    goal: parsed.goal,
    task: {
      task_id: parsed["task-id"] || null,
      task_category: parsed["task-category"] || null,
      task_action: parsed["task-action"] || null,
      task_domain: parsed["task-domain"] || null,
      criticality: parsed.criticality || "NORMAL",
    },
    live,
    mandatoryCore: { shadow: true },
  });
  print({ event: result.event, telemetryPath: result.telemetryPath });
} else if (command === "dream") {
  const live = parsed.live === true;
  const client = live ? new JevClient() : createFakeJevClient(() => 0.5);
  print(await annotateDreamDirectory({ projectRoot: repo, client, live }));
} else if (command === "evaluate") {
  const report = createProjectEvaluationReport(repo);
  print({ report, path: writeEvaluationReport(repo, report) });
} else if (command === "approve") {
  const report = parsed.report && existsSync(resolve(parsed.report))
    ? json(parsed.report)
    : loadStoredEvaluation(repo);
  if (!report) throw new Error("Stored Jev evaluation report is required; run evaluate first.");
  const approval = createLocalApproval({ report, note: parsed.note || "" });
  print({ approval, path: writeLocalApproval(repo, approval) });
} else {
  throw new Error(`Unknown command: ${command}`);
}
