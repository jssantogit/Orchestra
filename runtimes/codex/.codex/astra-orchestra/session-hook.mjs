import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  authorizeCodexSession,
  bootstrapCodexSessionAuthority,
  enterCodexSession,
  readCodexSessionAuthority,
} from "./session-authority.mjs";
import {
  authorizeCodexLeaseCapability,
  codexCapabilityForTool,
  enterCodexWorkLease,
  resolveCodexAuthorityMode,
} from "./work-lease-authority.mjs";
import { evaluateCodexVerificationTool } from "./verification-guard.mjs";
import { normalizeToolEvent } from "./provider/codex/adapter/tool-event.mjs";
import { attachProviderTelemetryReference } from "./provider/codex/adapter/telemetry.mjs";
import { authorizeCapability } from "./core/policy/capability-authorization.mjs";
import { authorizeMutation } from "./core/policy/mutation-authorization.mjs";
import { createRuntimeEvent } from "./core/events/runtime-event.mjs";

// Project-controlled, installed Codex agents only; Astra is explicitly
// manual-only and the orchestrator's own Sol Medium runs at the root.
// Native hook names must first be recognized by normalizeToolEvent.
const NATIVE_DELEGATION_ROLES = new Set([
  "luna-max", "luna-high", "luna-medium", "luna-auditor",
  "sol-high", "sol-xhigh", "sol-max",
  "sol-review-low", "sol-review-medium",
]);

function authorizeNativeAgentControl(payload, normalized, lease) {
  const child = Boolean(payload.agent_id || payload.agentId);
  // Only the factual root may call web and solicit user input. These are
  // deliberately explicit names, never a generic exemption for unknown tools.
  if (normalized.operation === "WEB_RESEARCH" || normalized.operation === "USER_CLARIFICATION") {
    return child
      ? { allowed: false, reason: "CHILD_CONTROL_TOOL_FORBIDDEN" }
      : { allowed: true, reason: null };
  }
  if (normalized.operation === "AGENT_MESSAGE") {
    // A worker may report facts to CONTROL. Peer-to-peer orders and arbitrary
    // destinations would bypass the parent coordinator; fail closed.
    return child && !["parent", "root"].includes(normalized.target)
      ? { allowed: false, reason: "CHILD_MESSAGE_TARGET_FORBIDDEN" }
      : { allowed: true, reason: null };
  }
  if (normalized.operation !== "DELEGATE" && normalized.operation !== "AGENT_CONTROL") {
    return { allowed: true, reason: null };
  }
  // The root may delegate but workers cannot recursively spawn/control agents.
  if (child) {
    return { allowed: false, reason: "CHILD_DELEGATION_FORBIDDEN" };
  }
  if (normalized.operation === "DELEGATE") {
    const input = payload.tool_input || payload.toolInput || {};
    const role = input.agent_type ?? input.agentType;
    if (typeof role !== "string" || !NATIVE_DELEGATION_ROLES.has(role)) {
      return { allowed: false, reason: "DELEGATION_ROLE_NOT_AUTHORIZED" };
    }
    if (input.fork_context === true || input.forkContext === true) {
      return { allowed: false, reason: "DELEGATION_CONTEXT_FORK_FORBIDDEN" };
    }
    if (lease.capabilities.includes("WORKSPACE_EDIT")) {
      return { allowed: false, reason: "DELEGATION_ACTIVE_WORKSPACE_WRITER" };
    }
  }
  return { allowed: true, reason: null };
}

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function parsePayload() {
  const raw = readStdin();
  if (!raw.trim()) return { ok: false, reason: "CODEX_HOOK_INPUT_MISSING", payload: {} };
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, reason: "CODEX_HOOK_INPUT_INVALID", payload: {} };
    }
    return { ok: true, reason: null, payload };
  } catch {
    return { ok: false, reason: "CODEX_HOOK_INPUT_MALFORMED", payload: {} };
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

function activePacket(repoRoot) {
  const active = readJson(join(repoRoot, ".codex", "orchestra-state", "active-state.json"), {}) || {};
  return active.implementationPacket
    || active.implementation_packet
    || active.directWork?.implementationPacket
    || active.direct_work?.implementation_packet
    || null;
}

function emitRuntimeEvent(repoRoot, payload, lease, normalized) {
  if (!lease || !normalized || normalized.eventType === "UNKNOWN") return;
  try {
    const event = createRuntimeEvent({
      type: normalized.eventType,
      generation: lease.generation,
      taskId: lease.taskId || null,
      actor: lease.actor,
    });
    let record = { event };
    if (payload.tool_call_id || payload.toolCallId || payload.tool_call?.id) {
      record = attachProviderTelemetryReference(event, payload);
    }
    const path = join(repoRoot, ".codex", "orchestra-state", "runtime-events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {}
}

// Codex 0.159.x has a closed provider-facing hook output schema.
 // Rich internal errors stay in the reason/context; never forward custom
 // top-level control flags that Codex would reject as unknown fields.
function sessionStartOutput(context, { stop = false, stopReason = null, systemMessage = null } = {}) {
  const message = [context, stopReason, systemMessage].filter(Boolean).join("\n");
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: message,
    },
  };
}

function preToolDeny(reason, _message = null) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function ensureCompatibilityProvenance(repoRoot, sessionId) {
  const current = readCodexSessionAuthority(repoRoot);
  if (current.exists) return current;
  try {
    bootstrapCodexSessionAuthority(repoRoot, { sessionId });
    return readCodexSessionAuthority(repoRoot);
  } catch (error) {
    return {
      exists: false,
      valid: false,
      reason: String(error?.message || error),
      record: null,
    };
  }
}

function handleLegacySessionStart(repoRoot, payload) {
  const entered = enterCodexSession(repoRoot, {
    sessionId: payload.session_id,
    source: payload.source || null,
  });

  if (!entered.authoritative) {
    return sessionStartOutput(
      [
        "ORCHESTRA CODEX SESSION HANDOFF REQUIRED [NON-AUTHORITATIVE].",
        "This Codex session does not own project orchestration authority.",
        "Do not execute project tools and do not ask the user to edit Orchestra state or copy a session ID.",
        "The previous factual main session must arm the managed boundary handoff after the current milestone is quiescent; then this session can claim automatically on a new SessionStart.",
        `Handoff status: ${entered.reason || "NO_VALID_HANDOFF"}.`,
        "No current Scope Contract, Evidence Ledger, worker identity, retry state, or continuation capsule is exposed to this session.",
      ].join(" "),
      { systemMessage: "Orchestra: this Codex session is not the current project orchestrator." },
    );
  }

  if (entered.claimed) {
    return sessionStartOutput(
      [
        "ORCHESTRA CODEX SESSION AUTHORITY HANDOFF CLAIMED [MILESTONE BOUNDARY].",
        `This session is now the factual main Codex orchestrator for lineage ${entered.authority.lineage_id}, generation ${entered.authority.generation}.`,
        "The prior milestone is sealed. Previous task scope, evidence, retries, workers, transcript, prompts, reasoning, and model summaries are not current-task authority.",
        "Runtime state is INTAKE. Classify the user's next milestone from scratch.",
        `Boundary capsule: ${JSON.stringify(entered.capsule || {})}`,
      ].join(" "),
    );
  }

  const authorityContext = [
    `ORCHESTRA CODEX SESSION AUTHORITY [AUTHORITATIVE]: lineage=${entered.authority.lineage_id}; generation=${entered.authority.generation}; source=${entered.authority.source}.`,
    "The factual session_id from Codex owns project tool authority for this lineage.",
    "Session authority does not import transcript, reasoning, Scope Contract, Evidence Ledger, or worker context. Use the provider-native Orchestra state modules for task facts.",
  ].join("\n");
  return sessionStartOutput(authorityContext);
}

function handleLeaseSessionStart(repoRoot, payload, mode) {
  const provenance = ensureCompatibilityProvenance(repoRoot, payload.session_id);
  const entered = enterCodexWorkLease(repoRoot, {
    sessionId: payload.session_id,
    mode,
  });

  if (!entered.authoritative) {
    return sessionStartOutput(
      [
        `ORCHESTRA CODEX WORK LEASE BLOCKED [${String(mode).toUpperCase()}].`,
        `Lease status: ${entered.reason || "WORK_LEASE_DENIED"}.`,
        "Session identity is provenance only; it cannot steal an active workspace writer lease.",
        "Do not mutate project state until the active writer releases or advances its factual Work Lease.",
      ].join(" "),
      { systemMessage: "Orchestra: this Codex session does not currently hold the project Work Lease." },
    );
  }

  const provenanceMismatch = Boolean(
    provenance.valid
    && provenance.record?.main_session_id
    && provenance.record.main_session_id !== payload.session_id,
  );
  const compatibility = !provenance.exists
    ? "missing"
    : provenance.valid
      ? (provenanceMismatch ? "historical-main-mismatch" : "matching")
      : `invalid:${provenance.reason || "unknown"}`;

  return sessionStartOutput([
    `ORCHESTRA CODEX WORK LEASE AUTHORITY [${String(mode).toUpperCase()}]: generation=${entered.lease.generation}; task=${entered.lease.taskId}; state=${entered.lease.state}.`,
    `Compatibility session provenance=${compatibility}.`,
    "The factual Codex session_id is actor provenance; the Work Lease generation and capabilities are project authority.",
    "A historical main_session_id mismatch is not an authority denial when the Work Lease claim is valid.",
    "Manual session handoff remains a recovery/debug compatibility path and is not required for normal fresh-chat continuation.",
    entered.lease.candidate ? `Candidate continuity=${entered.lease.candidate}.` : "Candidate continuity=none.",
  ].join("\n"));
}

function handleSessionStart(repoRoot, payload) {
  const mode = resolveCodexAuthorityMode();
  if (mode === "session") return handleLegacySessionStart(repoRoot, payload);
  return handleLeaseSessionStart(repoRoot, payload, mode);
}

function handleLegacyPreToolUse(repoRoot, payload) {
  const decision = authorizeCodexSession(repoRoot, payload.session_id);
  if (decision.allowed) {
    const verification = evaluateCodexVerificationTool(repoRoot, payload);
    if (!verification.allowed) {
      return preToolDeny(verification.reason,
        "Orchestra blocked a local command under this project's verification policy. Use the declared CI gate or revise the project policy.");
    }
    return null;
  }
  return preToolDeny(
    `CODEX_SESSION_AUTHORITY_DENIED:${decision.reason || "UNKNOWN"}. `
    + "Only the factual main Codex session may execute project tools. If the user requested a fresh chat, arm/claim the managed Orchestra session handoff instead of editing authority state manually."
  );
}

function handleLeasePreToolUse(repoRoot, payload, mode) {
  const control = authorizeCodexLeaseCapability(repoRoot, {
    sessionId: payload.session_id,
    capability: "CONTROL",
    mode,
  });
  if (!control.allowed) {
    return preToolDeny(
      `CODEX_WORK_LEASE_AUTHORITY_DENIED:${control.reason || "UNKNOWN"}.`,
      "Orchestra blocked this tool because the current Codex session does not hold the active Work Lease generation.",
    );
  }

  let normalized;
  try {
    normalized = normalizeToolEvent(payload);
  } catch (error) {
    return preToolDeny(`CODEX_PROVIDER_EVENT_DENIED:${error?.message || "INVALID_PROVIDER_EVENT"}.`);
  }
  if (normalized.eventType === "UNKNOWN" || normalized.operation === "UNKNOWN") {
    return preToolDeny("CODEX_PROVIDER_EVENT_DENIED:UNKNOWN_OPERATION.");
  }

  const agentControl = authorizeNativeAgentControl(payload, normalized, control.lease);
  if (!agentControl.allowed) {
    return preToolDeny(`CODEX_DELEGATION_DENIED:${agentControl.reason}.`);
  }

  const verification = evaluateCodexVerificationTool(repoRoot, payload);
  if (!verification.allowed) {
    return preToolDeny(verification.reason,
      "Orchestra blocked a local command under this project's verification policy. Use the declared CI gate or revise the project policy.");
  }

  const packet = activePacket(repoRoot);
  if (packet && normalized.operation === "READ") {
    const readDecision = authorizeCapability({
      actor: control.lease.actor,
      lease: control.lease,
      packet,
      operation: "READ",
      capability: "CONTROL",
    });
    if (!readDecision.allowed) {
      return preToolDeny(`CODEX_CAPABILITY_DENIED:${readDecision.reason}.`);
    }
  }

  const capability = codexCapabilityForTool(payload);
  let effectiveLease = control.lease;
  if (capability === "WORKSPACE_EDIT") {
    const mutation = authorizeCodexLeaseCapability(repoRoot, {
      sessionId: payload.session_id,
      generation: control.lease.generation,
      capability,
      mode,
    });
    if (!mutation.allowed) {
      return preToolDeny(
        `CODEX_WORK_LEASE_AUTHORITY_DENIED:${mutation.reason || "UNKNOWN"}.`,
        "Orchestra blocked workspace mutation because this actor does not hold the current generation-fenced WORKSPACE_EDIT capability.",
      );
    }
    effectiveLease = mutation.lease;
    const mutationDecision = authorizeMutation({
      actor: effectiveLease.actor,
      lease: effectiveLease,
      generation: effectiveLease.generation,
      workspace: { workspaceId: effectiveLease.workspaceId },
      operation: "WRITE",
    });
    if (!mutationDecision.allowed) {
      return preToolDeny(`CODEX_MUTATION_DENIED:${mutationDecision.reason}.`);
    }
    if (packet) {
      const capabilityDecision = authorizeCapability({
        actor: effectiveLease.actor,
        lease: effectiveLease,
        packet,
        operation: "WRITE",
        capability: "WORKSPACE_EDIT",
      });
      if (!capabilityDecision.allowed) {
        return preToolDeny(`CODEX_CAPABILITY_DENIED:${capabilityDecision.reason}.`);
      }
    }
  }

  emitRuntimeEvent(repoRoot, payload, effectiveLease, normalized);
  return null;
}

function handlePreToolUse(repoRoot, payload) {
  const mode = resolveCodexAuthorityMode();
  if (mode === "session") return handleLegacyPreToolUse(repoRoot, payload);
  return handleLeasePreToolUse(repoRoot, payload, mode);
}

function handleLegacyUserPromptSubmit(repoRoot, payload) {
  const decision = authorizeCodexSession(repoRoot, payload.session_id);
  if (decision.allowed) return null;
  return {
    decision: "block",
    reason: `CODEX_SESSION_AUTHORITY_DENIED:${decision.reason || "UNKNOWN"}. This session is not the factual Orchestra root. Continue in the current main session or complete the managed boundary handoff.`,
  };
}

// A text prompt never grants side-effect authority. Do not make a Codex chat
// hostage to another session's Work Lease: keep natural language available
// so a user can inspect or request recovery. Every actual tool remains gated
// by PreToolUse and the current generation-fenced Work Lease.
function handleLeaseUserPromptSubmit(_repoRoot, _payload, _mode) {
  return null;
}

function handleUserPromptSubmit(repoRoot, payload) {
  const mode = resolveCodexAuthorityMode();
  if (mode === "session") return handleLegacyUserPromptSubmit(repoRoot, payload);
  return handleLeaseUserPromptSubmit(repoRoot, payload, mode);
}

function main() {
  const parsed = parsePayload();
  if (!parsed.ok) {
    process.stderr.write(`Orchestra Codex session hook failed closed: ${parsed.reason}\n`);
    process.exitCode = 2;
    return;
  }

  const payload = parsed.payload;
  const repoRoot = repoRootFrom(payload.cwd);
  const event = String(payload.hook_event_name || "");

  if (event === "SessionStart") {
    console.log(JSON.stringify(handleSessionStart(repoRoot, payload)));
    return;
  }
  if (event === "PreToolUse") {
    const output = handlePreToolUse(repoRoot, payload);
    if (output) console.log(JSON.stringify(output));
    return;
  }
  if (event === "UserPromptSubmit") {
    const output = handleUserPromptSubmit(repoRoot, payload);
    if (output) console.log(JSON.stringify(output));
    return;
  }

  console.log(JSON.stringify({
    continue: false,
    stopReason: `CODEX_SESSION_HOOK_UNEXPECTED_EVENT:${event || "MISSING"}`,
    systemMessage: "Orchestra Codex session hook received an unexpected event.",
  }));
}

main();
