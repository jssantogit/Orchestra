import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  claimWorkLease,
  readWorkLease,
  transitionWorkLease,
} from "./core/leases/work-lease-store.mjs";
import { authorizeLeaseMutation } from "./core/leases/lease-authorizer.mjs";
import { isCodexNativeControlTool, normalizeToolEvent } from "./provider/codex/adapter/tool-event.mjs";
import { attachProviderTelemetryReference } from "./provider/codex/adapter/telemetry.mjs";
import { createRuntimeEvent } from "./core/events/runtime-event.mjs";

const VALID_MODES = new Set(["session", "dual", "lease"]);
const BINDINGS_SCHEMA = "orchestra.codex-work-lease-bindings.v1";
const DIAGNOSTIC_SCHEMA = "orchestra.codex-work-lease-diagnostic.v1";
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

function inspectBindings(repoRoot) {
  const path = bindingsPath(repoRoot);
  if (!existsSync(path)) {
    return { status: "MISSING", reason: null, bindingCount: 0, path, state: { schema: BINDINGS_SCHEMA, bindings: {} } };
  }
  const value = readJson(path, null);
  if (!value || value.schema !== BINDINGS_SCHEMA || !value.bindings || typeof value.bindings !== "object" || Array.isArray(value.bindings)) {
    return { status: "INVALID", reason: "LEASE_BINDINGS_INVALID", bindingCount: null, path, state: null };
  }
  return {
    status: "VALID",
    reason: null,
    bindingCount: Object.keys(value.bindings).length,
    path,
    state: value,
  };
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

// A session records the installed runtime image at factual SessionStart.
// Metadata-only re-stamping does not stale a session if image and manifest
// are unchanged. A replaced image cannot inherit the previous session's
// authority even when the old Work Lease generation has not changed.
function runtimeFingerprint(repoRoot) {
  const file = join(repoRoot, ".orchestra", "state", "runtimes", "codex.json");
  if (!existsSync(file)) return "RUNTIME_NOT_INSTALLED";
  const metadata = readJson(file, null);
  if (metadata?.schema !== "orchestra.project-runtime.v2"
    || metadata.runtime !== "codex"
    || !/^[a-f0-9]{64}$/.test(metadata.runtimeHash ?? "")
    || !/^[a-f0-9]{64}$/.test(metadata.manifestHash ?? "")) return null;
  return metadata.runtimeHash + ":" + metadata.manifestHash;
}

function runtimeBindingValid(repoRoot, binding) {
  const current = runtimeFingerprint(repoRoot);
  if (current === null) return { ok: false, reason: "RUNTIME_IDENTITY_UNREADABLE" };
  if (!binding || binding.runtimeFingerprint !== current) return { ok: false, reason: "SESSION_RUNTIME_STALE" };
  return { ok: true, reason: null };
}

function bindActorGeneration(repoRoot, actor, lease) {
  const current = readBindings(repoRoot) || { schema: BINDINGS_SCHEMA, bindings: {} };
  current.bindings[actor.sessionIdHash] = {
    generation: lease.generation,
    taskId: lease.taskId,
    workspaceId: lease.workspaceId,
    candidate: lease.candidate ?? null,
    runtimeFingerprint: runtimeFingerprint(repoRoot),
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

function diagnosticLease(current) {
  if (!current.exists) {
    return { status: "MISSING", reason: "WORK_LEASE_NOT_INITIALIZED", path: current.path, value: null };
  }
  if (!current.valid || !current.lease) {
    return {
      status: "INVALID",
      reason: current.reason || "LEASE_SCHEMA_INVALID",
      path: current.path,
      value: null,
      errors: current.errors || null,
    };
  }
  const lease = current.lease;
  return {
    status: "VALID",
    reason: null,
    path: current.path,
    value: {
      workspaceId: lease.workspaceId,
      taskId: lease.taskId,
      generation: lease.generation,
      state: lease.state,
      capabilities: Array.isArray(lease.capabilities) ? [...lease.capabilities] : [],
      candidate: lease.candidate ?? null,
      actorProvider: lease.actor?.provider || null,
    },
  };
}

function diagnosticSubject(actor) {
  if (actor) {
    return {
      scope: "SUPPLIED_ACTOR",
      identitySource: "CALLER_SUPPLIED_SESSION_ID",
      currentSessionVerified: false,
      warning: "Authority applies only to the supplied factual Codex hook session_id; do not infer the current session id from environment variables.",
    };
  }
  return {
    scope: "LEASE_ONLY",
    identitySource: "NONE",
    currentSessionVerified: false,
    warning: "No actor identity was supplied; authority for the current Codex session is not evaluated by this diagnostic.",
  };
}

// This journal is observational: it never grants, denies, upgrades, or releases
// a lease. Only the actual native PreToolUse/PostToolUse hook caller records an
// event. No tool arguments, prompt bodies, model context or raw session IDs are
// written. Provider tool-call references permit request/result correlation.
export function recordCodexHookToolReceipt(repoRoot, {
  payload, lease, leaseTransition = null, normalized = null,
} = {}) {
  if (!lease || !payload) return { recorded: false, reason: "RECEIPT_INPUT_MISSING" };
  try {
    const toolEvent = normalized || normalizeToolEvent(payload);
    if (toolEvent.eventType !== "TOOL_REQUEST" && toolEvent.eventType !== "TOOL_RESULT") {
      return { recorded: false, reason: "RECEIPT_EVENT_UNSUPPORTED" };
    }
    if (toolEvent.operation === "UNKNOWN") {
      return { recorded: false, reason: "RECEIPT_OPERATION_UNKNOWN" };
    }
    const toolCallId = toolEvent.factualIds.toolCallId || null;
    // Factual provider ID gives deterministic request/result identity with
    // the event type included; absent IDs get a unique non-correlatable event.
    const nonce = toolCallId || randomUUID();
    const eventId = `event-${createHash("sha256").update(JSON.stringify([
      toolEvent.eventType, lease.generation, lease.actor,
      toolEvent.factualIds.actorIdHash, nonce,
    ])).digest("hex").slice(0, 24)}`;
    const event = createRuntimeEvent({
      eventId, type: toolEvent.eventType,
      generation: lease.generation, taskId: lease.taskId || null,
      actor: lease.actor,
    });
    const base = toolCallId ? attachProviderTelemetryReference(event, payload) : { event };
    const record = {
      ...base,
      operation: toolEvent.operation,
      actorIdHash: toolEvent.factualIds.actorIdHash,
      ...(leaseTransition ? { leaseTransition } : {}),
    };
    const path = join(repoRoot, ".codex", "orchestra-state", "runtime-events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    return { recorded: true, reason: null, eventId };
  } catch (error) {
    return { recorded: false, reason: String(error?.code || error?.message || "RECEIPT_WRITE_FAILED") };
  }
}

export function resolveCodexAuthorityMode(value = process.env.ORCHESTRA_AUTHORITY_MODE) {
  if (value === undefined || value === null || String(value).trim() === "") return "lease";
  const normalized = String(value).trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : "session";
}

export function codexCapabilityForTool(payload = {}) {
  const name = clean(payload.tool_name || payload.toolName, 120).toLowerCase();
  if (READ_ONLY_TOOL_NAMES.has(name)) return "CONTROL";
  if (isCodexNativeControlTool(name)) return "CONTROL";
  if (name === "bash" || name === "shell" || name === "exec" || name === "run_command") {
    return readOnlyBash(payload.tool_input?.command || payload.toolInput?.command || "")
      ? "CONTROL"
      : "WORKSPACE_EDIT";
  }
  return "WORKSPACE_EDIT";
}

export function diagnoseCodexWorkLease(repoRoot, { sessionId, mode = undefined } = {}) {
  const authorityMode = resolveCodexAuthorityMode(mode);
  const current = readWorkLease(repoRoot);
  const lease = diagnosticLease(current);
  const bindingInspection = inspectBindings(repoRoot);
  const actor = actorFor(sessionId);
  const subject = diagnosticSubject(actor);
  let actorBinding = null;
  let bindings = {
    status: bindingInspection.status,
    reason: bindingInspection.reason,
    path: bindingInspection.path,
    bindingCount: bindingInspection.bindingCount,
    generation: null,
  };

  if (actor && bindingInspection.status === "VALID") {
    actorBinding = bindingInspection.state.bindings[actor.sessionIdHash] || null;
    bindings = {
      ...bindings,
      status: actorBinding ? "BOUND" : "UNBOUND",
      reason: actorBinding ? null : "LEASE_BINDING_MISSING",
      generation: Number.isInteger(actorBinding?.generation) ? actorBinding.generation : null,
    };
  }

  let authority = { status: "UNKNOWN", reason: null };
  if (authorityMode === "session") {
    authority = { status: "UNKNOWN", reason: "SESSION_AUTHORITY_MODE" };
  } else if (!actor) {
    authority = { status: "UNKNOWN", reason: "CODEX_SESSION_ID_REQUIRED" };
  } else if (lease.status === "MISSING") {
    authority = { status: "DENIED", reason: "WORK_LEASE_NOT_INITIALIZED" };
  } else if (lease.status === "INVALID") {
    authority = { status: "DENIED", reason: lease.reason };
  } else if (bindingInspection.status === "INVALID") {
    authority = { status: "DENIED", reason: "LEASE_BINDINGS_INVALID" };
  } else if (!actorBinding) {
    authority = { status: "DENIED", reason: "LEASE_BINDING_MISSING" };
  } else if (actorBinding.generation !== current.lease.generation) {
    authority = { status: "DENIED", reason: "STALE_WORK_LEASE" };
  } else {
    const decision = authorizeLeaseMutation({
      lease: current.lease,
      actor,
      generation: actorBinding.generation,
      capability: "CONTROL",
    });
    authority = {
      status: decision.allowed ? "ALLOWED" : "DENIED",
      reason: decision.allowed ? null : decision.reason,
    };
  }

  return {
    schema: DIAGNOSTIC_SCHEMA,
    ok: true,
    mode: authorityMode,
    subject,
    lease,
    bindings,
    authority,
  };
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
    const runtime = runtimeBindingValid(repoRoot, actorBinding.binding);
    if (!runtime.ok) {
      return { handled: true, authoritative: false, reason: runtime.reason, mode: authorityMode, lease: current.lease ?? null };
    }
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

  if (runtimeFingerprint(repoRoot) === null) {
    return { handled: true, authoritative: false, reason: "RUNTIME_IDENTITY_UNREADABLE", mode: authorityMode, lease: current.lease ?? null };
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
  const runtime = runtimeBindingValid(repoRoot, actorBinding.binding);
  if (!runtime.ok) return { handled: true, allowed: false, reason: runtime.reason, mode: authorityMode, lease: null };

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
  const runtime = runtimeBindingValid(repoRoot, actorBinding.binding);
  if (!runtime.ok) return { handled: true, released: false, reason: runtime.reason, mode: authorityMode, lease: null };
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
