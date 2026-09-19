#!/usr/bin/env node
import process from "node:process";

import {
  cancelCodexSessionHandoff,
  codexSessionHandoffStatus,
  prepareCodexSessionHandoff,
} from "./session-authority.mjs";

function usage() {
  return [
    "Usage:",
    "  node .codex/astra-orchestra/session-handoff-cli.mjs prepare --boundary [--reason TEXT] [--label TEXT]",
    "  node .codex/astra-orchestra/session-handoff-cli.mjs status",
    "  node .codex/astra-orchestra/session-handoff-cli.mjs cancel [--reason TEXT]",
    "",
    "Normal flow: the factual Terra root executes prepare after explicit user intent to continue in a fresh chat.",
    "The user does not copy session IDs or edit Orchestra state.",
  ].join("\n");
}

function valueAfter(args, name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const repoRoot = process.cwd();

  if (!command || ["-h", "--help", "help"].includes(command)) {
    console.log(usage());
    return;
  }

  if (command === "prepare") {
    if (!args.includes("--boundary")) throw new Error("CODEX_SESSION_HANDOFF_BOUNDARY_FLAG_REQUIRED");
    const result = prepareCodexSessionHandoff(repoRoot, {
      reason: valueAfter(args, "--reason"),
      label: valueAfter(args, "--label"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify(codexSessionHandoffStatus(repoRoot), null, 2));
    return;
  }

  if (command === "cancel") {
    const result = cancelCodexSessionHandoff(repoRoot, { reason: valueAfter(args, "--reason") });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`CODEX_SESSION_HANDOFF_UNKNOWN_COMMAND:${command}`);
}

try {
  main();
} catch (error) {
  console.error(String(error?.message || error));
  process.exitCode = 1;
}
