#!/usr/bin/env node
import { resolve } from "node:path";
import {
  disableShadowMode,
  enableShadowMode,
  loadShadowConfig,
  summarizeShadowSession,
} from "./shadow-mode.mjs";

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

function print(value) { console.log(JSON.stringify(value, null, 2)); }
function fail(message, code = 1) { console.error(message); process.exit(code); }
function usage() {
  console.log("Orchestra Dream Layer — Milestone G Shadow Mode\n\n"
    + "enable  --repo <path> --candidate <policy-id> --evaluation <evaluation-id>\n"
    + "status  --repo <path>\n"
    + "report  --repo <path> [--session <shadow-session-id>]\n"
    + "disable --repo <path>\n\n"
    + "Shadow computes candidate actions privately but never executes them. Canary is a later milestone.");
}

const { flags, positional } = parse(process.argv.slice(2));
const command = positional[0];
if (!command || command === "help" || flags.help) { usage(); process.exit(0); }
if (!flags.repo) fail("--repo is required");
const repoRoot = resolve(flags.repo);

if (command === "enable") {
  if (!flags.candidate || !flags.evaluation) fail("--candidate and --evaluation are required");
  const out = enableShadowMode({
    repoRoot,
    candidatePolicyId: flags.candidate,
    evaluationId: flags.evaluation,
  });
  print(out); process.exit(out.enabled ? 0 : 2);
}

if (command === "status") {
  const out = loadShadowConfig(repoRoot);
  print(out); process.exit(out.active ? 0 : 3);
}

if (command === "report") {
  const out = summarizeShadowSession({
    repoRoot,
    shadowSessionId: flags.session || null,
  });
  print(out); process.exit(out.summarized ? 0 : 4);
}

if (command === "disable") {
  const out = disableShadowMode(repoRoot);
  print(out); process.exit(out.disabled ? 0 : 5);
}

fail("Unknown command: " + command);
