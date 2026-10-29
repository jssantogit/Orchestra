import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  codexCapabilityForTool,
  releaseCodexLeaseWrite,
  recordCodexHookToolReceipt,
  resolveCodexAuthorityMode,
} from "./work-lease-authority.mjs";

function readPayload() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    const payload = JSON.parse(raw);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function repoRootFrom(cwd) {
  const base = resolve(String(cwd || process.cwd()));
  try {
    const root = execFileSync("git", ["-C", base, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (root) return resolve(root);
  } catch {}
  let cursor = base;
  while (true) {
    if (existsSync(join(cursor, ".codex"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return base;
    cursor = parent;
  }
}

function main() {
  const mode = resolveCodexAuthorityMode();
  if (mode === "session") return;
  const payload = readPayload();
  if (!payload || String(payload.hook_event_name || "") !== "PostToolUse") return;
  if (codexCapabilityForTool(payload) !== "WORKSPACE_EDIT") return;

  const result = releaseCodexLeaseWrite(repoRootFrom(payload.cwd), {
    sessionId: payload.session_id,
    mode,
  });
  if (result.reason) {
    process.stderr.write(`Orchestra Work Lease writer release failed closed: ${result.reason}\n`);
  }
  // A native PostToolUse record exists only if this native hook ran; the
  // receipt reports a release solely when the generation-fenced transition
  // actually succeeded. It is not evidence that an absent callback occurred.
  if (result.lease) {
    const receipt = recordCodexHookToolReceipt(repoRootFrom(payload.cwd), {
      payload, lease: result.lease,
      leaseTransition: result.released ? "WORKSPACE_EDIT_RELEASED" : null,
    });
    if (!receipt.recorded) {
      process.stderr.write(`Orchestra Codex PostToolUse receipt unavailable: ${receipt.reason}\n`);
    }
  }
}

main();
