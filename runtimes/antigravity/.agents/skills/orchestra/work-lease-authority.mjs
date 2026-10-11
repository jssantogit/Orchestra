import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  claimWorkLease,
  readWorkLease,
  transitionWorkLease,
} from "./core/leases/work-lease-store.mjs";
import { authorizeLeaseMutation } from "./core/leases/lease-authorizer.mjs";
import { ensureProjectStateIgnored } from "./project-state-ignore.mjs";

const VALID_MODES = new Set(["session", "dual", "lease"]);
const BINDINGS_SCHEMA = "orchestra.antigravity-work-lease-bindings.v1";

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
  const path = join(repoRoot, ".agents", "state", "active-state.json");
  const active = existsSync(path) ? readJson(path, {}) : {};
  return {
    taskId: clean(active.taskId || active.taskKey || "antigravity:intake", 300),
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

function actorFor(conversationId) {
  const id = clean(conversationId, 300);
  if (!id) return null;
  return { provider: "antigravity", sessionIdHash: `sha256:${digest(id)}` };
}

function isRootIdentity({ parentConversationId = null, role = null, profile = null } = {}) {
  if (clean(parentConversationId, 300)) return false;
  const normalizedRole = clean(role, 80).toUpperCase();
  const normalizedProfile = clean(profile, 120).toLowerCase();
  if (normalizedRole && !["ORCHESTRATOR", "CONTROL", "ROOT"].includes(normalizedRole)) return false;
  if (normalizedProfile && normalizedProfile !== "flash-orchestrator") return false;
  return true;
}

function bindingsPath(repoRoot) {
  return join(repoRoot, ".agents", "state", "work-lease-conversation-bindings.json");
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

export function resolveAntigravityAuthorityMode(value = process.env.ORCHESTRA_AUTHORITY_MODE) {
  if (value === undefined || value === null || String(value).trim() === "") return "dual";
  const normalized = String(value).trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : "session";
}

export function enterAntigravityWorkLease(repoRoot, {
  conversationId,
  parentConversationId = null,
  role = null,
  profile = null,
  mode = undefined,
} = {}) {
  const authorityMode = resolveAntigravityAuthorityMode(mode);
  if (authorityMode === "session") {
    return { handled: false, authoritative: false, reason: "SESSION_AUTHORITY_MODE", mode: authorityMode, lease: null };
  }
  if (!isRootIdentity({ parentConversationId, role, profile })) {
    return { handled: true, authoritative: false, reason: "LEASE_ROOT_REQUIRED", mode: authorityMode, lease: null };
  }
  const actor = actorFor(conversationId);
  if (!actor) return { handled: true, authoritative: false, reason: "ANTIGRAVITY_CONVERSATION_ID_REQUIRED", mode: authorityMode, lease: null };
  ensureProjectStateIgnored(repoRoot);

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

export function authorizeAntigravityLeaseCapability(repoRoot, {
  conversationId,
  generation = null,
  capability = "CONTROL",
  mode = undefined,
} = {}) {
  const authorityMode = resolveAntigravityAuthorityMode(mode);
  if (authorityMode === "session") {
    return { handled: false, allowed: false, reason: "SESSION_AUTHORITY_MODE", mode: authorityMode, lease: null };
  }
  const actor = actorFor(conversationId);
  if (!actor) return { handled: true, allowed: false, reason: "ANTIGRAVITY_CONVERSATION_ID_REQUIRED", mode: authorityMode, lease: null };
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
    const control = authorizeLeaseMutation({ lease, actor, generation: requestedGeneration, capability: "CONTROL" });
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

  const decision = authorizeLeaseMutation({ lease, actor, generation: requestedGeneration, capability });
  return { handled: true, ...decision, mode: authorityMode, lease };
}
