#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { diagnoseCodexWorkLease } from "./work-lease-authority.mjs";

function codedError(code, message, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function usageError(message) {
  return codedError("ORCHESTRA_WORK_LEASE_DIAGNOSTIC_USAGE", message);
}

function assertReadableDiagnosticState(repoRoot) {
  const targets = [
    {
      path: join(repoRoot, ".orchestra", "state", "work-lease.json"),
      code: "ORCHESTRA_WORK_LEASE_READ_FAILED",
      label: "Work Lease",
    },
    {
      path: join(repoRoot, ".codex", "orchestra-state", "work-lease-session-bindings.json"),
      code: "ORCHESTRA_WORK_LEASE_BINDINGS_READ_FAILED",
      label: "Work Lease bindings",
    },
  ];

  for (const target of targets) {
    if (!existsSync(target.path)) continue;
    try {
      readFileSync(target.path, "utf8");
    } catch (cause) {
      throw codedError(target.code, `${target.label} state cannot be read`, cause);
    }
  }
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

    assertReadableDiagnosticState(options.repoRoot);
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
