#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildAndPersistPolicyDataset,
  buildPolicyDesignerPacket,
  evaluatePolicyLabCycle,
  openPolicyLabCycle,
  submitDesignerCandidates,
} from "./policy-lab.mjs";

function parse(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { flags, positional };
}

function json(path) { return JSON.parse(readFileSync(resolve(path), "utf8")); }
function print(value) { console.log(JSON.stringify(value, null, 2)); }
function fail(message, code = 1) { console.error(message); process.exit(code); }
function usage() {
  console.log("Orchestra Dream Layer — Milestone F Policy Lab\n\n"
    + "dataset  --repo <path>\n"
    + "open     --repo <path>\n"
    + "packet   --repo <path> --cycle <cycle.json>\n"
    + "submit   --repo <path> --cycle <cycle.json> --candidates <json>\n"
    + "evaluate --repo <path> --cycle <cycle.json>\n\n"
    + "The Policy Lab never activates a candidate policy. Shadow Mode is a later milestone.");
}

const { flags, positional } = parse(process.argv.slice(2));
const command = positional[0];
if (!command || command === "help" || flags.help) { usage(); process.exit(0); }

if (command === "dataset") {
  if (!flags.repo) fail("--repo is required");
  const out = buildAndPersistPolicyDataset(resolve(flags.repo));
  print(out); process.exit(out.ok ? 0 : 2);
}

if (command === "open") {
  if (!flags.repo) fail("--repo is required");
  if (flags.dataset) fail("--dataset is not accepted; cycles must derive from locally sealed worlds");
  const built = buildAndPersistPolicyDataset(resolve(flags.repo));
  if (!built.ok) { print(built); process.exit(2); }
  const out = openPolicyLabCycle({ repoRoot: resolve(flags.repo), dataset: built.dataset });
  print(out); process.exit(out.opened ? 0 : 3);
}

if (command === "packet") {
  if (!flags.repo || !flags.cycle) fail("--repo and --cycle are required");
  const out = buildPolicyDesignerPacket({ repoRoot: resolve(flags.repo), cyclePath: resolve(flags.cycle) });
  print(out); process.exit(out.ok ? 0 : 4);
}

if (command === "submit") {
  if (!flags.repo || !flags.cycle || !flags.candidates) fail("--repo, --cycle and --candidates are required");
  if (!existsSync(resolve(flags.candidates))) fail("Candidates file not found");
  const raw = json(flags.candidates);
  const candidates = Array.isArray(raw) ? raw : raw?.candidates;
  const out = submitDesignerCandidates({
    repoRoot: resolve(flags.repo),
    cyclePath: resolve(flags.cycle),
    candidates,
  });
  print(out); process.exit(out.accepted ? 0 : 5);
}

if (command === "evaluate") {
  if (!flags.repo || !flags.cycle) fail("--repo and --cycle are required");
  const out = evaluatePolicyLabCycle({ repoRoot: resolve(flags.repo), cyclePath: resolve(flags.cycle) });
  print(out); process.exit(out.evaluated ? 0 : 6);
}

fail("Unknown command: " + command);
