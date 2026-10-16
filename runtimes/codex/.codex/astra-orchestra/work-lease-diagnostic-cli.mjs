#!/usr/bin/env node

import { resolve } from "node:path";

import { diagnoseCodexWorkLease } from "./work-lease-authority.mjs";

function usageError(message) {
  const error = new Error(message);
  error.code = "ORCHESTRA_WORK_LEASE_DIAGNOSTIC_USAGE";
  return error;
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    sessionId: undefined,
    mode: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      const value = argv[++index];
      if (!value) throw usageError("--repo-root requires a value");
      options.repoRoot = resolve(value);
      continue;
    }
    if (arg === "--session-id") {
      const value = argv[++index];
      if (!value) throw usageError("--session-id requires a factual provider session id");
      options.sessionId = value;
      continue;
    }
    if (arg === "--mode") {
      const value = argv[++index];
      if (!value) throw usageError("--mode requires a value");
      options.mode = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, ...options };
    }
    throw usageError(`unknown argument: ${arg}`);
  }

  return options;
}

export function runWorkLeaseDiagnosticCli(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write([
        "Usage: node .codex/astra-orchestra/work-lease-diagnostic-cli.mjs [options]",
        "",
        "Options:",
        "  --repo-root <path>   Project root (defaults to cwd)",
        "  --session-id <id>    Factual Codex session id for actor-specific authority diagnosis",
        "  --mode <mode>        Authority mode override: lease, dual, or session",
        "  -h, --help           Show this help",
        "",
        "The command is read-only. Semantic states such as MISSING, INVALID, or DENIED exit 0.",
      ].join("\n") + "\n");
      return 0;
    }

    const result = diagnoseCodexWorkLease(options.repoRoot, {
      sessionId: options.sessionId,
      mode: options.mode,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (error) {
    const payload = {
      schema: "orchestra.codex-work-lease-diagnostic-error.v1",
      ok: false,
      error: {
        code: error?.code || "ORCHESTRA_WORK_LEASE_DIAGNOSTIC_FAILED",
        message: String(error?.message || error || "unknown diagnostic failure"),
      },
    };
    process.stderr.write(JSON.stringify(payload, null, 2) + "\n");
    return 2;
  }
}

process.exitCode = runWorkLeaseDiagnosticCli();
