#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ORCHESTRATOR_HANDOFF_MODES,
  cancelProjectOrchestratorHandoff,
  claimProjectOrchestratorHandoff,
  formatOrchestratorHandoffStatus,
  prepareProjectOrchestratorHandoff,
  readProjectOrchestratorHandoff,
} from "./orchestrator-handoff.mjs";

function parse(argv) {
  const positional = [];
  const flags = {
    json: false,
    mode: ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY,
    reason: null,
    label: null,
    conversationId: null,
    parentConversationId: null,
    modelName: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--live") flags.mode = ORCHESTRATOR_HANDOFF_MODES.LIVE_CONTINUATION;
    else if (arg === "--boundary") flags.mode = ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY;
    else if (arg === "--reason") flags.reason = argv[++i] || null;
    else if (arg === "--label") flags.label = argv[++i] || null;
    else if (arg === "--conversation-id") flags.conversationId = argv[++i] || null;
    else if (arg === "--parent-conversation-id") flags.parentConversationId = argv[++i] || null;
    else if (arg === "--model") flags.modelName = argv[++i] || null;
    else positional.push(arg);
  }
  return { positional, flags };
}

function defaultRepoRoot() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return resolve(here, "..", "..", "..");
}

function usage() {
  return [
    "Orchestra Orchestrator Session Handoff",
    "",
    "Usage:",
    "  orchestrator-handoff prepare [project] [--boundary|--live] [--reason <text>] [--label <text>] [--json]",
    "  orchestrator-handoff status [project] [--json]",
    "  orchestrator-handoff cancel [project] [--reason <text>] [--json]",
    "  orchestrator-handoff claim <project> --conversation-id <id> [--parent-conversation-id <id>] [--model <name>] [--json]",
    "",
    "Normal workflow: the orchestrator prepares the handoff; Antigravity PreInvocation",
    "claims it automatically in the next root conversation. The claim command is",
    "recovery/debug tooling only.",
  ].join("\n");
}

export async function runOrchestratorHandoffCli(argv = process.argv.slice(2), {
  defaultTargetDir = null,
} = {}) {
  const { positional, flags } = parse(argv);
  const command = positional[0];
  const targetDir = resolve(positional[1] || defaultTargetDir || defaultRepoRoot());

  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return 0;
  }

  let result;
  if (command === "prepare") {
    result = prepareProjectOrchestratorHandoff(targetDir, {
      mode: flags.mode,
      reason: flags.reason,
      label: flags.label,
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.changed
        ? "Orchestrator handoff armed."
        : "Orchestrator handoff already armed for the same unchanged state.");
      console.log(formatOrchestratorHandoffStatus({ record: result.record }));
      console.log("");
      console.log("Open the fresh root chat in this project. Authority will transfer automatically on its first invocation.");
    }
    return 0;
  }

  if (command === "status") {
    result = readProjectOrchestratorHandoff(targetDir);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.exists) console.log("Orchestrator handoff: none");
    else if (!result.valid) console.log("Orchestrator handoff: INVALID — " + result.reason);
    else console.log(formatOrchestratorHandoffStatus(result));
    return result.valid ? 0 : 1;
  }

  if (command === "cancel") {
    result = cancelProjectOrchestratorHandoff(targetDir, flags.reason);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.changed ? "Orchestrator handoff cancelled." : "No armed handoff was changed.");
      if (result.record) console.log(formatOrchestratorHandoffStatus({ record: result.record }));
      if (result.reason) console.log("Reason: " + result.reason);
    }
    return result.changed || result.reason === "ORCHESTRATOR_HANDOFF_NOT_FOUND" ? 0 : 1;
  }

  if (command === "claim") {
    if (!flags.conversationId) {
      console.error("Recovery claim requires --conversation-id <id>.");
      return 2;
    }
    result = claimProjectOrchestratorHandoff(targetDir, {
      candidateConversationId: flags.conversationId,
      parentConversationId: flags.parentConversationId,
      modelName: flags.modelName,
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.claimed ? "Orchestrator handoff claimed." : "Orchestrator handoff not claimed.");
      console.log("Reason: " + (result.reason || "-"));
      if (result.claimed) {
        console.log("Lineage: " + result.lineageId);
        console.log("Generation: " + result.generation);
      }
    }
    return result.claimed ? 0 : 1;
  }

  console.error("Unknown command: " + command);
  console.error(usage());
  return 2;
}

async function main() {
  try {
    process.exitCode = await runOrchestratorHandoffCli();
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 2;
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) await main();
