#!/usr/bin/env node
// V1.5 one-shot operator recovery, not an automatic liveness inference.
// A Work Lease has no native proof that its former Codex owner died. Only the
// operator can confirm that the old session and tools were closed. No tool,
// daemon or background process is started for normal Codex interactions.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { readWorkLease, releaseWorkLease } from "../core/leases/work-lease-store.mjs";

function failure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function options(args) {
  const command = args.shift();
  if (!["inspect", "abandon"].includes(command)) failure("RECOVERY_COMMAND_INVALID");
  const values = { command, root: process.cwd(), expected: null, confirm: false, preserveDirty: false };
  const seen = new Set();
  while (args.length) {
    const arg = args.shift();
    if (seen.has(arg)) failure("RECOVERY_OPTIONS_INVALID");
    seen.add(arg);
    if (arg === "--repo-root") {
      values.root = args.shift();
      if (!values.root || values.root.startsWith("--")) failure("RECOVERY_OPTIONS_INVALID");
    } else if (arg === "--expected-generation") {
      const value = args.shift();
      if (!/^(?:0|[1-9]\d*)$/.test(value || "")) failure("RECOVERY_OPTIONS_INVALID");
      values.expected = Number(value);
      if (!Number.isSafeInteger(values.expected)) failure("RECOVERY_OPTIONS_INVALID");
    } else if (arg === "--confirm-old-session-closed") {
      values.confirm = true;
    } else if (arg === "--preserve-dirty") {
      values.preserveDirty = true;
    } else {
      failure("RECOVERY_OPTIONS_INVALID");
    }
  }
  if (command === "inspect" && (values.expected !== null || values.confirm || values.preserveDirty)) {
    failure("RECOVERY_OPTIONS_INVALID");
  }
  if (command === "abandon" && values.expected === null) failure("RECOVERY_EXPECTED_GENERATION_REQUIRED");
  return values;
}

function rootPath(input) {
  const root = realpathSync(resolve(input));
  const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8", windowsHide: true, timeout: 5_000,
  }).trim();
  if (realpathSync(top) !== root) failure("RECOVERY_WORKTREE_ROOT_REQUIRED");
  return root;
}

function workspace(root) {
  try {
    // Internal state is never work product; it must not mark an otherwise clean
    // worktree dirty. No changes are staged, cleaned, checked out or reset.
    const output = execFileSync("git", [
      "-C", root, "status", "--porcelain=v1", "--untracked-files=all", "--",
      ".", ":(exclude).orchestra/state", ":(exclude).codex/orchestra-state",
      ":(exclude).codex/orchestra-telemetry", ":(exclude).codex/runtime-management",
    ], { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 });
    return output.trim() ? "DIRTY" : "CLEAN";
  } catch {
    return "UNKNOWN";
  }
}

function inspect(root) {
  const current = readWorkLease(root);
  const workspaceStatus = workspace(root);
  let status;
  if (!current.valid) status = "LEASE_UNKNOWN";
  else if (!current.exists) status = "NO_WORK_LEASE";
  else if (current.lease.capabilities.includes("WORKSPACE_EDIT")) status = "WRITER_LIVENESS_UNKNOWN";
  else status = "NO_ACTIVE_WRITER";
  return {
    schema: "orchestra.v1.5-recovery-inspection.v1",
    ok: true,
    status,
    workspace: workspaceStatus,
    canAutoRecover: false,
    generation: current.valid && current.exists ? current.lease.generation : null,
    taskId: current.valid && current.exists ? current.lease.taskId : null,
    advice: status === "WRITER_LIVENESS_UNKNOWN"
      ? "Close the former Codex session and confirm its tools are no longer executing. Only then may the operator explicitly abandon the old writer. Timeout alone is not liveness proof."
      : "Normal fresh-session attach is preferred when no writer is active.",
  };
}

function abandon(root, expected, confirm, preserveDirty) {
  const observed = inspect(root);
  if (observed.status === "LEASE_UNKNOWN") failure("RECOVERY_LEASE_UNKNOWN");
  if (observed.status !== "WRITER_LIVENESS_UNKNOWN") failure("RECOVERY_NO_ORPHANED_WRITER");
  if (observed.generation !== expected) failure("RECOVERY_STALE_GENERATION");
  if (!confirm) failure("RECOVERY_EXPLICIT_CONFIRMATION_REQUIRED");
  if (observed.workspace === "UNKNOWN") failure("RECOVERY_WORKSPACE_UNKNOWN");
  if (observed.workspace === "DIRTY" && !preserveDirty) {
    failure("RECOVERY_DIRTY_WORKSPACE_CONFIRMATION_REQUIRED");
  }

  const current = readWorkLease(root);
  if (!current.valid || !current.exists) failure("RECOVERY_LEASE_UNKNOWN");
  if (current.lease.generation !== expected || !current.lease.capabilities.includes("WORKSPACE_EDIT")) {
    failure("RECOVERY_STALE_GENERATION");
  }
  const receiptId = randomUUID();
  const recordBase = {
    schema: "orchestra.operator-lease-recovery.v1",
    receiptId,
    observedAt: new Date().toISOString(),
    generation: expected,
    actorHash: current.lease.actor.sessionIdHash,
    workspace: observed.workspace,
    liveness: "OPERATOR_ATTESTED_NOT_PROVEN",
    decision: "ABANDON_WRITER_PRESERVE_WORKSPACE",
  };
  const journal = join(root, ".orchestra", "state", "operator-recoveries.jsonl");
  // The Work Lease already created the state directory. Journal intent before
  // the fenced transition, so failure to save the intent cannot silently act.
  appendFileSync(journal, JSON.stringify({ ...recordBase, phase: "INTENT" }) + "\n", "utf8");
  const result = releaseWorkLease(root, {
    generation: expected,
    actor: current.lease.actor,
    terminalState: "BLOCKED",
  });
  if (!result.released) failure("RECOVERY_RACE_OR_LOCKED", result.reason);
  appendFileSync(journal, JSON.stringify({ ...recordBase, phase: "APPLIED" }) + "\n", "utf8");
  return {
    ok: true, recovered: true, receiptId,
    status: "OPERATOR_RECOVERY_APPLIED",
    generation: expected,
    workspace: observed.workspace,
    newLeaseState: result.lease.state,
    note: "The old generation has no mutation capability. Start a new factual Codex session; do not resume an in-flight old tool. Product files were not modified.",
  };
}

function main() {
  try {
    const p = options(process.argv.slice(2));
    const root = rootPath(p.root);
    const response = p.command === "inspect" ? inspect(root)
      : abandon(root, p.expected, p.confirm, p.preserveDirty);
    process.stdout.write(JSON.stringify(response) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      code: error?.code || "RECOVERY_INSPECTION_FAILED",
      message: String(error?.message || error),
      statePreserved: true,
    }) + "\n");
    process.exitCode = 2;
  }
}

main();
