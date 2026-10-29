// Native Codex audit-only subdelegation. Sol CONTROL can arm exactly one
// Terra audit lead for the current Work Lease generation. A factual
// SubagentStart binds the Terra agent_id, then Terra may spawn only one
// read-only luna-auditor. This is not generic recursive delegation.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA = "orchestra.codex-audit-delegation.v1";
const LEAD = "terra-audit-lead";
const WORKER = "luna-auditor";

function hash(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
function scopeHash(root) {
  try {
    const state = JSON.parse(readFileSync(join(root, ".codex", "orchestra-state", "active-state.json"), "utf8"));
    const packet = state.implementationPacket || state.implementation_packet;
    const scope = packet?.scopeContract || packet?.scope_contract;
    if (!scope || !Array.isArray(scope.allowedPaths) || scope.allowedPaths.length === 0
      || !scope.allowedPaths.every(p => typeof p === "string" && p.trim())
      || !Array.isArray(scope.forbiddenPaths) || scope.maxDelegations !== 1) return null;
    return hash(JSON.stringify(scope));
  } catch { return null; }
}
function auditFile(root) {
  return join(root, ".codex", "orchestra-state", "audit-delegation.json");
}
function read(root) {
  try {
    const s = JSON.parse(readFileSync(auditFile(root), "utf8"));
    if (s.schema !== SCHEMA || !Number.isSafeInteger(s.generation)
      || !s.rootActor || !/^sha256:[0-9a-f]{64}$/.test(s.scopeHash)
      || typeof s.taskId !== "string"
      || !Number.isInteger(s.usedChildren) || s.usedChildren < 0 || s.usedChildren > 1
      || (s.leadHash !== null && !/^sha256:[0-9a-f]{64}$/.test(s.leadHash))) {
      return { ok: false, reason: "AUDIT_GRANT_INVALID" };
    }
    return { ok: true, value: s };
  } catch (error) {
    return { ok: false, reason: error?.code === "ENOENT"
      ? "AUDIT_GRANT_MISSING" : "AUDIT_GRANT_UNREADABLE" };
  }
}
function isCurrent(s, lease, root) {
  return s.generation === lease.generation
    && s.taskId === lease.taskId
    && s.rootActor === lease.actor?.sessionIdHash
    && s.scopeHash === scopeHash(root)
    && lease.capabilities?.includes("CONTROL");
}
function transact(root, operation) {
  const file = auditFile(root);
  const lock = file + ".lock";
  mkdirSync(dirname(file), { recursive: true });
  // Atomic mkdir is our cross-process exclusion. A crashed/stale lock fails
  // closed; no hook autonomously breaks it or silently resets a grant.
  try { mkdirSync(lock); } catch { return { allowed: false, reason: "AUDIT_GRANT_BUSY" }; }
  try {
    const result = operation(read(root));
    if (result?.next) {
      const tmp = file + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(tmp, JSON.stringify(result.next, null, 2) + "\n", { mode: 0o600 });
        renameSync(tmp, file);
      } finally { rmSync(tmp, { force: true }); }
    }
    return { allowed: result.allowed === true, reason: result.reason || null };
  } catch {
    return { allowed: false, reason: "AUDIT_GRANT_IO_FAILURE" };
  } finally {
    try { rmSync(lock, { recursive: false }); } catch {}
  }
}

// Arming is possible only in the root's already-authorized native
// PreToolUse spawn path. Root selecting this special profile is the opt-in.
export function armTerraAudit(root, payload, lease) {
  if (payload.agent_id || payload.agentId) return { allowed: false, reason: "AUDIT_ROOT_REQUIRED" };
  const input = payload.tool_input || payload.toolInput || {};
  if (input.agent_type !== LEAD || input.fork_context === true || input.forkContext === true) {
    return { allowed: false, reason: "AUDIT_SPAWN_INVALID" };
  }
  if (!lease?.actor?.sessionIdHash || lease.capabilities?.includes("WORKSPACE_EDIT")) {
    return { allowed: false, reason: "AUDIT_ROOT_LEASE_INVALID" };
  }
  // The task identity and immutable generation fence this bounded grant.
  if (!lease.taskId || lease.taskId === "codex:intake") {
    return { allowed: false, reason: "AUDIT_TASK_SCOPE_REQUIRED" };
  }
  const currentScopeHash = scopeHash(root);
  if (!currentScopeHash) return { allowed: false, reason: "AUDIT_SCOPE_CONTRACT_REQUIRED" };
  return transact(root, (old) => {
    if (old.ok && old.value.generation === lease.generation) {
      return { allowed: false, reason: "AUDIT_LEAD_ALREADY_ARMED" };
    }
    if (!old.ok && old.reason !== "AUDIT_GRANT_MISSING") {
      return { allowed: false, reason: old.reason };
    }
    return { allowed: true, next: {
      schema: SCHEMA, generation: lease.generation, taskId: lease.taskId,
      rootActor: lease.actor.sessionIdHash, scopeHash: currentScopeHash,
      leadHash: null, usedChildren: 0,
    } };
  });
}

// SubagentStart is advisory, not a blocking hook; only this write
// establishes the factual Terra identity. PreToolUse still gates every spawn.
export function bindTerraAudit(root, payload, lease) {
  if (payload.hook_event_name !== "SubagentStart"
    || payload.agent_type !== LEAD
    || typeof payload.agent_id !== "string" || !payload.agent_id.trim()) {
    return { allowed: false, reason: "AUDIT_START_IDENTITY_REQUIRED" };
  }
  return transact(root, (old) => {
    if (!old.ok) return { allowed: false, reason: old.reason };
    const s = old.value;
    if (!isCurrent(s, lease, root)) return { allowed: false, reason: "AUDIT_GRANT_STALE" };
    if (s.leadHash !== null) return { allowed: s.leadHash === hash(payload.agent_id),
      reason: s.leadHash === hash(payload.agent_id) ? null : "AUDIT_LEAD_ALREADY_BOUND" };
    return { allowed: true, next: { ...s, leadHash: hash(payload.agent_id) } };
  });
}

export function authorizeTerraChildAudit(root, payload, lease) {
  const input = payload.tool_input || payload.toolInput || {};
  if (lease.capabilities?.includes("WORKSPACE_EDIT")) {
    return { allowed: false, reason: "AUDIT_ACTIVE_WRITER" };
  }
  if (payload.agent_type !== LEAD || typeof payload.agent_id !== "string"
    || !payload.agent_id || input.agent_type !== WORKER
    || input.fork_context === true || input.forkContext === true) {
    return { allowed: false, reason: "AUDIT_CHILD_SCOPE_FORBIDDEN" };
  }
  return transact(root, (old) => {
    if (!old.ok) return { allowed: false, reason: old.reason };
    const s = old.value;
    if (!isCurrent(s, lease, root) || s.leadHash !== hash(payload.agent_id)) {
      return { allowed: false, reason: "AUDIT_LEAD_NOT_BOUND" };
    }
    if (s.usedChildren >= 1) return { allowed: false, reason: "AUDIT_CHILD_BUDGET_EXHAUSTED" };
    return { allowed: true, next: { ...s, usedChildren: 1 } };
  });
}

export function isReadOnlyAuditRole(payload) {
  return Boolean(payload.agent_id || payload.agentId)
    && [LEAD, WORKER].includes(payload.agent_type ?? payload.agentType);
}
