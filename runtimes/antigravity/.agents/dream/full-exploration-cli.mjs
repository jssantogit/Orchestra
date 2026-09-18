#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectFullExplorationBranch,
  fullExplorationStatus,
  prepareFullExplorationBranch,
  runFullExplorationBranch,
  startFullExploration,
  stopFullExploration,
} from "./full-exploration.mjs";

function parse(argv) {
  const flags = {}, pass = [], positional = [];
  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (passthrough) { pass.push(token); continue; }
    if (token === "--") { passthrough = true; continue; }
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const key = token.slice(2), next = argv[i + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { flags, pass, positional };
}
function print(value) { console.log(JSON.stringify(value, null, 2)); }
function fail(message, code = 1) { console.error(message); process.exit(code); }
function json(path) { return JSON.parse(readFileSync(resolve(path), "utf8")); }
function usage() {
  console.log("Orchestra Dream Layer — Milestone K Full Exploration Policy\n\n"
    + "start   --repo <path>\n"
    + "status  --repo <path>\n"
    + "prepare --repo <path> --world <world.json> --seed <branch-seed.json> [--decision-id ID]\n"
    + "run     --repo <path> --branch <branch-id> -- agy [args...]\n"
    + "collect --repo <path> --branch <branch-id>\n"
    + "stop    --repo <path> [--reason text]");
}
const { flags, pass, positional } = parse(process.argv.slice(2));
const command = positional[0];
if (!command || command === "help" || flags.help) { usage(); process.exit(0); }
if (!flags.repo) fail("--repo is required");
const repoRoot = resolve(flags.repo);

if (command === "start") {
  const out = startFullExploration({ repoRoot }); print(out); process.exit(out.started ? 0 : 2);
}
if (command === "status") {
  print(fullExplorationStatus({ repoRoot })); process.exit(0);
}
if (command === "prepare") {
  if (!flags.world || !flags.seed) fail("--world and --seed are required");
  if (!existsSync(resolve(flags.world)) || !existsSync(resolve(flags.seed))) fail("World or seed file not found");
  const out = prepareFullExplorationBranch({
    repoRoot,
    world: json(flags.world),
    seedPath: resolve(flags.seed),
    decisionId: flags["decision-id"] || null,
  });
  print(out); process.exit(out.prepared ? 0 : 3);
}
if (command === "run") {
  if (!flags.branch || pass.length === 0) fail("--branch and a command after -- are required");
  const out = runFullExplorationBranch({ repoRoot, branchId: flags.branch, command: pass[0], args: pass.slice(1) });
  print(out); process.exit(out.ran && !out.timed_out && (out.exit_code === 0 || out.exit_code === null) ? 0 : 4);
}
if (command === "collect") {
  if (!flags.branch) fail("--branch is required");
  const out = collectFullExplorationBranch({ repoRoot, branchId: flags.branch });
  print(out); process.exit(out.collected ? 0 : 5);
}
if (command === "stop") {
  const out = stopFullExploration({ repoRoot, reason: flags.reason || "HUMAN_STOP" });
  print(out); process.exit(out.stopped ? 0 : 6);
}
fail("Unknown command: " + command);
