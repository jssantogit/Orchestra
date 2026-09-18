#!/usr/bin/env node
import { resolve } from "node:path";
import {
  approveCanary,
  loadCanaryConfig,
  promoteCanary,
  rollbackCanary,
  summarizeCanarySession,
} from "./canary-mode.mjs";

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
  console.log("Orchestra Dream Layer — Milestone H Human-approved Canary\n\n"
    + "approve  --repo <path> --shadow-report <id> --confirm\n"
    + "status   --repo <path>\n"
    + "report   --repo <path> [--session <canary-session-id>]\n"
    + "rollback --repo <path> --confirm\n"
    + "promote  --repo <path> --canary-report <id> --confirm\n\n"
    + "Canary traffic is fixed at 5%. Approval and final promotion are separate explicit human actions.");
}

const { flags, positional } = parse(process.argv.slice(2));
const command = positional[0];
if (!command || command === "help" || flags.help) { usage(); process.exit(0); }
if (!flags.repo) fail("--repo is required");
const repoRoot = resolve(flags.repo);

if (command === "approve") {
  if (!flags["shadow-report"]) fail("--shadow-report is required");
  if (flags.confirm !== true) fail("--confirm is required for human Canary approval");
  const out = approveCanary({
    repoRoot,
    shadowReportId: flags["shadow-report"],
    humanApproval: true,
  });
  print(out); process.exit(out.approved ? 0 : 2);
}

if (command === "status") {
  const out = loadCanaryConfig(repoRoot);
  print(out); process.exit(out.active ? 0 : 3);
}

if (command === "report") {
  const out = summarizeCanarySession({
    repoRoot,
    canarySessionId: flags.session || null,
  });
  print(out); process.exit(out.summarized ? 0 : 4);
}

if (command === "rollback") {
  if (flags.confirm !== true) fail("--confirm is required for manual Canary rollback");
  const out = rollbackCanary({
    repoRoot,
    trigger: "HUMAN_MANUAL_ROLLBACK",
    details: { approved_by: "HUMAN_EXPLICIT_CLI" },
  });
  print(out); process.exit(out.rolled_back ? 0 : 5);
}

if (command === "promote") {
  if (!flags["canary-report"]) fail("--canary-report is required");
  if (flags.confirm !== true) fail("--confirm is required for human policy promotion");
  const out = promoteCanary({
    repoRoot,
    canaryReportId: flags["canary-report"],
    humanApproval: true,
  });
  print(out); process.exit(out.promoted ? 0 : 6);
}

fail("Unknown command: " + command);
