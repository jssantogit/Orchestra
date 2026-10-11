import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  claimWorkLease,
  readWorkLease,
  transitionWorkLease,
} from "./core/leases/work-lease-store.mjs";
import { authorizeLeaseMutation } from "./core/leases/lease-authorizer.mjs";

const VALID_MODES = new Set(["session", "dual", "lease"]);
const BINDINGS_SCHEMA = "orchestra.codex-work-lease-bindings.v1";
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

function bindingsPath(repoRoot) {
  return join(repoRoot, ".codex", "orchestra-state", "work-lease-session-bindings.json");
}

function readBindings(repoRoot) {
  const path = bindingsPath(repoRoot);
  if (!existsSync(path)) return { schema: BINDINGS_SCHEMA, bindings: {} };
  const value = readJson(path, null);
  if (!value || value.schema !== BINDINGS_SCHEMA || !value.bindings || typeof value.bindings !== "object" || Array.isArray(value.bindings)) {
    return null;
  }
  return value;
}

function writeBindings(repoRoot, value) {
  const path = bindingsPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

function readActorBinding(repoRoot, actor) {
  const state = readBindings(repoRoot);
  if (!state) return { valid: false, reason: "LEASE_BINDINGS_INVALID", binding: null, state: null };
  return {
    valid: true,
    reason: null,
    binding: state.bindings[actor.sessionIdHash] || null,
    state,
  };
}

function bindActorGeneration(repoRoot, actor, lease) {
  const current = readBindings(repoRoot) || { schema: BINDINGS_SCHEMA, bindings: {} };
  current.bindings[actor.sessionIdHash] = {
    generation: lease.generation,
    taskId: lease.taskId,
    workspaceId: lease.workspaceId,
    candidate: lease.candidate ?? null,
  };
  writeBindings(repoRoot, current);
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

  const actorBinding = readActorBinding(repoRoot, actor);
  if (!actorBinding.valid) {
    return { handled: true, authoritative: false, reason: actorBinding.reason, mode: authorityMode, lease: null };
  }
  const current = readWorkLease(repoRoot);
  if (actorBinding.binding) {
    if (!current.exists || !current.valid || !current.lease) {
      return { handled: true, authoritative: false, reason: current.reason || "STALE_WORK_LEASE", mode: authorityMode, lease: current.lease || null };
    }
    const decision = authorizeLeaseMutation({
      lease: current.lease,
      actor,
      generation: actorBinding.binding.generation,
      capability: "CONTROL",
    });
    return {
      handled: true,
      authoritative: decision.allowed,
      reason: decision.allowed ? null : (actorBinding.binding.generation !== current.lease.generation ? "STALE_WORK_LEASE" : decision.reason),
      mode: authorityMode,
      lease: current.lease,
      taskId: current.lease.taskId,
      candidate: current.lease.candidate,
    };
  }

  const context = activeContext(repoRoot);
  const claim = claimWorkLease(repoRoot, {
    workspaceId: "primary",
    taskId: context.taskId,
    actor,
    capabilities: ["CONTROL"],
    candidate: context.candidate,
  });
  if (claim.claimed && claim.lease) bindActorGeneration(repoRoot, actor, claim.lease);
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
  const actorBinding = readActorBinding(repoRoot, actor);
  if (!actorBinding.valid) return { handled: true, allowed: false, reason: actorBinding.reason, mode: authorityMode, lease: null };
  if (!actorBinding.binding) return { handled: true, allowed: false, reason: "LEASE_BINDING_MISSING", mode: authorityMode, lease: null };

  const current = readWorkLease(repoRoot);
  if (!current.exists || !current.valid || !current.lease) {
    return { handled: true, allowed: false, reason: current.reason || "WORK_LEASE_NOT_INITIALIZED", mode: authorityMode, lease: current.lease || null };
  }
  const lease = current.lease;
  const requestedGeneration = Number.isInteger(generation) ? generation : actorBinding.binding.generation;
  if (requestedGeneration !== actorBinding.binding.generation) {
    return { handled: true, allowed: false, reason: "STALE_WORK_LEASE", mode: authorityMode, lease };
  }

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

export function releaseCodexLeaseWrite(repoRoot, { sessionId, mode = undefined } = {}) {
  const authorityMode = resolveCodexAuthorityMode(mode);
  if (authorityMode === "session") {
    return { handled: false, released: false, reason: "SESSION_AUTHORITY_MODE", mode: authorityMode, lease: null };
  }
  const actor = actorFor(sessionId);
  if (!actor) return { handled: true, released: false, reason: "CODEX_SESSION_ID_REQUIRED", mode: authorityMode, lease: null };
  const actorBinding = readActorBinding(repoRoot, actor);
  if (!actorBinding.valid || !actorBinding.binding) {
    return { handled: true, released: false, reason: actorBinding.reason || "LEASE_BINDING_MISSING", mode: authorityMode, lease: null };
  }
  const current = readWorkLease(repoRoot);
  if (!current.exists || !current.valid || !current.lease) {
    return { handled: true, released: false, reason: current.reason || "WORK_LEASE_NOT_INITIALIZED", mode: authorityMode, lease: current.lease || null };
  }
  const lease = current.lease;
  const generation = actorBinding.binding.generation;
  const control = authorizeLeaseMutation({ lease, actor, generation, capability: "CONTROL" });
  if (!control.allowed) return { handled: true, released: false, reason: control.reason, mode: authorityMode, lease };
  if (!lease.capabilities.includes("WORKSPACE_EDIT")) {
    return { handled: true, released: false, reason: null, mode: authorityMode, lease };
  }
  const result = transitionWorkLease(repoRoot, {
    generation,
    actor,
    state: "CONTROL",
    capabilities: ["CONTROL"],
    candidate: lease.candidate,
  });
  return {
    handled: true,
    released: Boolean(result.changed),
    reason: result.reason || null,
    mode: authorityMode,
    lease: result.lease || lease,
  };
}
