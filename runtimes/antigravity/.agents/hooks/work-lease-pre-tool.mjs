import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  authorizeAntigravityLeaseCapability,
  resolveAntigravityAuthorityMode,
} from "../skills/orchestra/work-lease-authority.mjs";

const legacyHook = resolve(dirname(fileURLToPath(import.meta.url)), "pre-tool-enforce.mjs");

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function parseWorkspacePath(p) {
  if (!p || typeof p !== "string") return "";
  if (p.startsWith("file://")) {
    try { return fileURLToPath(p); } catch { return p.replace(/^file:\/\/\/?/, ""); }
  }
  return p;
}

function repoRootFrom(payload = {}) {
  const cwd = process.cwd();
  const rawWs = (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0])
    || (Array.isArray(payload.workspaceUris) && payload.workspaceUris[0])
    || null;
  if (rawWs) return resolve(parseWorkspacePath(rawWs));
  if (basename(cwd) === ".agents") return resolve(cwd, "..");
  if (existsSync(resolve(cwd, ".agents"))) return cwd;
  if (existsSync(resolve(cwd, "../.agents"))) return resolve(cwd, "..");
  return cwd;
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function delegate(rawInput) {
  const result = spawnSync(process.execPath, [legacyHook], {
    cwd: process.cwd(),
    input: rawInput,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.status ?? (result.error ? 2 : 0);
}

function main() {
  const rawInput = readStdin();
  let payload;
  try { payload = JSON.parse(rawInput || "{}"); } catch {
    delegate(rawInput);
    return;
  }

  const mode = resolveAntigravityAuthorityMode();
  if (mode === "session") {
    delegate(rawInput);
    return;
  }

  const repoRoot = repoRootFrom(payload);
  const convId = payload.conversationId || null;
  const bindings = readJson(resolve(repoRoot, ".agents/state/role-bindings.json"), {});
  const record = convId
    ? ((bindings?.bindings && bindings.bindings[convId]) || (bindings?.conversations && bindings.conversations[convId]) || null)
    : null;
  const role = String(record?.role || payload.agentRole || payload.role || "").toUpperCase();
  const parentConversationId = record?.parentConversationId || payload.parentConversationId || payload.parent_conversation_id || null;
  const currentMain = bindings?.mainConversationId || null;
  const rootLike = !parentConversationId && (
    role === "ORCHESTRATOR"
    || role === "FORMER_ORCHESTRATOR"
    || (convId && currentMain && convId === currentMain)
    || (!record && !role)
  );

  if (!rootLike) {
    delegate(rawInput);
    return;
  }

  const decision = authorizeAntigravityLeaseCapability(repoRoot, {
    conversationId: convId,
    capability: "CONTROL",
    mode,
  });
  if (!decision.allowed) {
    console.log(JSON.stringify({
      decision: "deny",
      reason:
        `ORCHESTRA_WORK_LEASE_AUTHORITY_DENIED:${decision.reason || "UNKNOWN"}. `
        + "This root conversation does not hold the current generation-fenced Work Lease. Continue in the current root conversation.",
    }));
    return;
  }

  delegate(rawInput);
}

main();
