#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  armExplorationCapture,
  collectExplorationResult,
  prepareExploration,
  runExplorationCommand,
} from "./exploration-lab.mjs";

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
  console.log("Orchestra Dream Layer — Milestone E Explicit Exploration Lab\\n\\n"
    + "arm     --repo <path> [--decision-type TYPE] [--approve-major]\\n"
    + "prepare --repo <path> --world <world.json> --seed <branch-seed.json> [--decision-id ID]\\n"
    + "run     --workspace <isolated-path> -- <agy-or-command> [args...]\\n"
    + "collect --repo <primary-path> --workspace <isolated-path>");
}
const { flags, pass, positional } = parse(process.argv.slice(2));
const command = positional[0];
if (!command || command === "help" || flags.help) { usage(); process.exit(0); }

if (command === "arm") {
  if (!flags.repo) fail("--repo is required");
  const out = armExplorationCapture({
    repoRoot: resolve(flags.repo),
    decisionType: flags["decision-type"] || null,
    approveMajor: flags["approve-major"] === true,
  });
  print(out); process.exit(out.armed ? 0 : 2);
}
if (command === "prepare") {
  if (!flags.repo || !flags.world || !flags.seed) fail("--repo, --world and --seed are required");
  if (!existsSync(resolve(flags.world)) || !existsSync(resolve(flags.seed))) fail("World or seed file not found");
  const out = prepareExploration({
    repoRoot: resolve(flags.repo),
    seedPath: resolve(flags.seed),
    world: json(flags.world),
    decisionId: flags["decision-id"] || null,
  });
  print(out); process.exit(out.prepared ? 0 : 3);
}
if (command === "run") {
  if (!flags.workspace || pass.length === 0) fail("--workspace and a command after -- are required");
  const out = runExplorationCommand({ branchWorkspace: resolve(flags.workspace), command: pass[0], args: pass.slice(1) });
  print(out); process.exit(out.ran && !out.timed_out && (out.exit_code === 0 || out.exit_code === null) ? 0 : 4);
}
if (command === "collect") {
  if (!flags.repo || !flags.workspace) fail("--repo and --workspace are required");
  const out = collectExplorationResult({ primaryRepoRoot: resolve(flags.repo), branchWorkspace: resolve(flags.workspace) });
  print(out); process.exit(out.collected ? 0 : 5);
}
fail("Unknown command: " + command);
