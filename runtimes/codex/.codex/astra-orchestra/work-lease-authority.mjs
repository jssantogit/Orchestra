import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  claimWorkLease,
  readWorkLease,
  transitionWorkLease,
} from "./core/leases/work-lease-store.mjs";
import { authorizeLeaseMutation } from "./core/leases/lease-authorizer.mjs";

const VALID_MODES = new Set(["session", "dual", "lease"]);
const READ_ONLY_TOOL_NAMES = new Set([
  "read", "read_file", "view_file", "grep", "glob", "ls", "list_files", "search",
]);

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function readJson(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function activeContext(repoRoot) {
  const path = join(repoRoot, ".codex", "orchestra-state", "active-state.json");
  const active = existsSync(path) ? readJson(path, {}) : {};
  return {
    taskId: clean(active.taskId || active.taskKey || "codex:intake", 300),
    candidate: clean(
      active.candidateId
      || active.candidate?.candidateId
      || active.evidenceCandidateId
      || active.evidenceCandidateHead
      || active.candidateHead
      || "",
      300,
    ) || null,
  };
}

function actorFor(sessionId) {
  const sid = clean(sessionId, 300);
  if (!sid) return null;
  return { provider: "codex", sessionIdHash: `sha256:${digest(sid)}` };
}

function hasShellControlOperator(command) {
  return /(?:&&|\|\||[;|><`]|\$\()/u.test(command);
}

function readOnlyGit(command) {
  return /^git\s+(?:status(?:\s|$)|diff(?:\s|$)|log(?:\s|$)|show(?:\s|$)|rev-parse(?:\s|$)|ls-files(?:\s|$)|grep(?:\s|$)|branch\s+--show-current(?:\s|$)|remote\s+-v(?:\s|$))/u.test(command);
}

function readOnlyFind(command) {
  return /^find(?:\s|$)/u.test(command) && !/\s-(?:delete|exec|execdir|ok)(?:\s|$)/u.test(command);
}

function readOnlyBash(command) {
  const text = clean(command, 4000);
  if (!text || hasShellControlOperator(text)) return false;
  if (readOnlyGit(text)) return true;
  if (readOnlyFind(text)) return true;
  return /^(?:rg|grep|cat|head|tail|wc|ls|pwd)(?:\s|$)/u.test(text);
}

export function resolveCodexAuthorityMode(value = process.env.ORCHESTRA_AUTHORITY_MODE) {
  if (value === undefined || value === null || String(value).trim() === "") return "dual";
  const normalized = String(value).trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : "session";
}

export function codexCapabilityForTool(payload = {}) {
  const name = clean(payload.tool_name || payload.toolName, 120).toLowerCase();
  if (READ_ONLY_TOOL_NAMES.has(name)) return "CONTROL";
  if (name === "bash" || name === "shell" || name === "exec" || name === "run_command") {
    return readOnlyBash(payload.tool_input?.command || payload.toolInput?.command || "")
      ? "CONTROL"
      : "WORKSPACE_EDIT";
  }
  return "WORKSPACE_EDIT";
}

export function enterCodexWorkLease(repoRoot, { sessionId, mode = undefined } = {}) {
  const authorityMode = resolveCodexAuthorityMode(mode);
  if (authorityMode === "session") {
    return { handled: false, authoritative: false, reason: "SESSION_AUTHORITY_MODE", mode: authorityMode, lease: null };
  }
  const actor = actorFor(sessionId);
  if (!actor) return { handled: true, authoritative: false, reason: "CODEX_SESSION_ID_REQUIRED", mode: authorityMode, lease: null };
  const context = activeContext(repoRoot);
  const claim = claimWorkLease(repoRoot, {
    workspaceId: "primary",
    taskId: context.taskId,
    actor,
    capabilities: ["CONTROL"],
    candidate: context.candidate,
  });
  return {
    handled: true,
    authoritative: Boolean(claim.claimed),
    reason: claim.reason || null,
    mode: authorityMode,
    lease: claim.lease || null,
    taskId: context.taskId,
    candidate: context.candidate,
  };
}

export function authorizeCodexLeaseCapability(repoRoot, {
  sessionId,
  generation = null,
  capability = "CONTROL",
  mode = undefined,
} = {}) {
  const authorityMode = resolveCodexAuthorityMode(mode);
  if (authorityMode === "session") {
    return { handled: false, allowed: false, reason: "SESSION_AUTHORITY_MODE", mode: authorityMode, lease: null };
  }
  const actor = actorFor(sessionId);
  if (!actor) return { handled: true, allowed: false, reason: "CODEX_SESSION_ID_REQUIRED", mode: authorityMode, lease: null };
  const current = readWorkLease(repoRoot);
  if (!current.exists || !current.valid || !current.lease) {
    return { handled: true, allowed: false, reason: current.reason || "WORK_LEASE_NOT_INITIALIZED", mode: authorityMode, lease: current.lease || null };
  }
  const lease = current.lease;
  const requestedGeneration = Number.isInteger(generation) ? generation : lease.generation;

  if (capability === "WORKSPACE_EDIT" && !lease.capabilities.includes("WORKSPACE_EDIT")) {
    const control = authorizeLeaseMutation({
      lease,
      actor,
      generation: requestedGeneration,
      capability: "CONTROL",
    });
    if (!control.allowed) return { handled: true, ...control, mode: authorityMode, lease };
    const upgraded = transitionWorkLease(repoRoot, {
      generation: requestedGeneration,
      actor,
      state: "IMPLEMENTING",
      capabilities: [...new Set([...lease.capabilities, "CONTROL", "WORKSPACE_EDIT"])],
      candidate: lease.candidate,
    });
    if (!upgraded.changed) {
      return { handled: true, allowed: false, reason: upgraded.reason || "WORK_LEASE_UPGRADE_DENIED", mode: authorityMode, lease: upgraded.lease || lease };
    }
    return { handled: true, allowed: true, reason: null, mode: authorityMode, lease: upgraded.lease };
  }

  const decision = authorizeLeaseMutation({
    lease,
    actor,
    generation: requestedGeneration,
    capability,
  });
  return { handled: true, ...decision, mode: authorityMode, lease };
}
