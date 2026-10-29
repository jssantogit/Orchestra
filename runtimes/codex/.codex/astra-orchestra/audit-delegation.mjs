// Native Codex audit-only subdelegation. Sol CONTROL can arm exactly one
// Terra audit lead for the current Work Lease generation. A factual
// SubagentStart binds the Terra agent_id, then Terra may spawn only one
// read-only luna-auditor. This is not generic recursive delegation.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, rmdirSync } from "node:fs";
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
    const audit = state.auditDelegation;
    if (!scope || !Array.isArray(scope.allowedPaths) || scope.allowedPaths.length === 0
      || !scope.allowedPaths.every(p => typeof p === "string" && p.trim())
      || !Array.isArray(scope.forbiddenPaths)
      || audit?.enabled !== true || audit.leadRole !== LEAD
      || audit.workerRole !== WORKER || audit.maxChildren !== 1) return null;
    // Keep audit-specific permission outside the strictly validated
    // orchestra.scope-contract.v2 (additionalProperties:false).
    return hash(JSON.stringify({ scope, audit }));
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
      || (s.leadHash !== null && !/^sha256:[0-9a-f]{64}$/.test(s.leadHash))
      || (s.childTaskName !== null && !/^[a-z][a-z0-9_]{0,63}$/.test(s.childTaskName))
      || (s.childCallHash !== null && !/^sha256:[0-9a-f]{64}$/.test(s.childCallHash))
      || (s.childPath !== null && (typeof s.childPath !== "string"
        || !/^\/root\/[a-z][a-z0-9_]{0,63}\/[a-z][a-z0-9_]{0,63}$/.test(s.childPath)))
      || typeof s.childConfirmed !== "boolean") {
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
    try { rmdirSync(lock); } catch {}
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
      childTaskName: null, childCallHash: null, childPath: null, childConfirmed: false,
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
  const taskName = typeof input.task_name === "string" ? input.task_name : null;
  const callId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;
  // V2's task_name and tool_use_id are required for subsequent control.
  // A legacy unnamed spawn retains the one-worker budget, but never
  // grants follow-up/interrupt or other named-child privileges.
  if ((taskName !== null && !/^[a-z][a-z0-9_]{0,63}$/.test(taskName))
    || (callId !== null && !callId.trim())
    || (taskName !== null && !callId)) {
    return { allowed: false, reason: "AUDIT_CHILD_NATIVE_ID_REQUIRED" };
  }
  return transact(root, (old) => {
    if (!old.ok) return { allowed: false, reason: old.reason };
    const s = old.value;
    if (!isCurrent(s, lease, root) || s.leadHash !== hash(payload.agent_id)) {
      return { allowed: false, reason: "AUDIT_LEAD_NOT_BOUND" };
    }
    if (s.usedChildren >= 1) return { allowed: false, reason: "AUDIT_CHILD_BUDGET_EXHAUSTED" };
    return { allowed: true, next: {
      ...s, usedChildren: 1, childTaskName: taskName, childCallHash: callId ? hash(callId) : null,
      childPath: null, childConfirmed: false,
    } };
  });
}

export function isReadOnlyAuditRole(payload) {
  return Boolean(payload.agent_id || payload.agentId)
    && [LEAD, WORKER].includes(payload.agent_type ?? payload.agentType);
}

// A native PostToolUse result is necessary to prove the chosen local name
// actually resolved to a successfully created direct child of Terra.
// Never authorize controls from PreToolUse alone or from guessed agent IDs.
export function confirmTerraAuditChild(root, payload, lease) {
  if (payload.hook_event_name !== "PostToolUse"
    || payload.agent_type !== LEAD || !payload.agent_id
    || !["collaborationspawn_agent", "spawn_agent"].includes(payload.tool_name)) {
    return { allowed: false, reason: "AUDIT_RESULT_NOT_CHILD_SPAWN" };
  }
  const input = payload.tool_input || {};
  const result = payload.tool_response;
  if (!result || typeof result !== "object" || Array.isArray(result)
    || typeof result.task_name !== "string") {
    return { allowed: false, reason: "AUDIT_NATIVE_SPAWN_RESULT_MISSING" };
  }
  return transact(root, (old) => {
    if (!old.ok) return { allowed: false, reason: old.reason };
    const s = old.value;
    if (!isCurrent(s, lease, root) || s.leadHash !== hash(String(payload.agent_id))) {
      return { allowed: false, reason: "AUDIT_LEAD_NOT_BOUND" };
    }
    if (s.usedChildren !== 1 || !s.childTaskName || !s.childCallHash
      || typeof payload.tool_use_id !== "string"
      || hash(payload.tool_use_id) !== s.childCallHash
      || input.agent_type !== WORKER || input.task_name !== s.childTaskName) {
      return { allowed: false, reason: "AUDIT_SPAWN_RESULT_UNMATCHED" };
    }
    const chunks = result.task_name.split("/");
    // The V2 child path is exactly /root/<Terra>/<Luna>.
    // No full path or arbitrary ID is ever accepted from Terra for control.
    if (chunks.length !== 4 || chunks[0] !== "" || chunks[1] !== "root"
      || !/^[a-z][a-z0-9_]{0,63}$/.test(chunks[2])
      || chunks[3] !== s.childTaskName) {
      return { allowed: false, reason: "AUDIT_SPAWN_RESULT_OUTSIDE_PARENT" };
    }
    if (s.childConfirmed) return { allowed: true };
    return { allowed: true, next: { ...s, childConfirmed: true, childPath: result.task_name } };
  });
}

// This never broadens the root's control or delegates acceptance. For V2
// only an exact relative task name is valid; absolute paths and IDs can
// address peers or ancestor agents and remain denied.
export function authorizeTerraAuditControl(root, payload, lease) {
  if (payload.agent_type !== LEAD || !payload.agent_id
    || lease.capabilities?.includes("WORKSPACE_EDIT")) {
    return { allowed: false, reason: "AUDIT_CONTROL_ACTOR_FORBIDDEN" };
  }
  const name = String(payload.tool_name ?? "").trim().toLowerCase();
  const input = payload.tool_input || {};
  const wait = name === "collaborationwait_agent" || name === "wait_agent";
  const directed = new Set(["collaborationsend_message", "send_message",
    "collaborationfollowup_task", "followup_task",
    "collaborationinterrupt_agent", "interrupt_agent"]);
  const list = name === "collaborationlist_agents" || name === "list_agents";
  if (!wait && !directed.has(name) && !list) return { allowed: false, reason: "AUDIT_CONTROL_TOOL_FORBIDDEN" };
  const state = read(root);
  if (!state.ok) return { allowed: false, reason: state.reason };
  const s = state.value;
  if (!isCurrent(s, lease, root) || s.leadHash !== hash(String(payload.agent_id))
    || !s.childConfirmed || s.usedChildren !== 1 || !s.childTaskName) {
    return { allowed: false, reason: "AUDIT_CHILD_NOT_CONFIRMED" };
  }
  if (wait) {
    // Codex V2 wait_agent waits on the caller's own mailbox; no target.
    // A targeted V1 wait may cross agent boundaries and is denied.
    const keys = Object.keys(input);
    const timeout = input.timeout_ms;
    const valid = keys.every(key => key === "timeout_ms")
      && (timeout === undefined || (Number.isInteger(timeout) && timeout > 0 && timeout <= 300000));
    return valid ? { allowed: true, reason: null } :
      { allowed: false, reason: "AUDIT_WAIT_UNSCOPED" };
  }
  if (list) {
    // Provider list_agents permits a caller-supplied prefix. Only the
    // confirmed child's canonical prefix is allowed, never the entire tree.
    return s.childPath && Object.keys(input).length === 1
      && input.path_prefix === s.childPath
      ? { allowed: true, reason: null }
      : { allowed: false, reason: "AUDIT_LIST_PREFIX_FORBIDDEN" };
  }
  const keys = Object.keys(input);
  const message = name.includes("send_message") || name.includes("followup_task");
  const validKeys = message ? ["target", "message"] : ["target"];
  if (!keys.every(k => validKeys.includes(k))
    || input.target !== s.childTaskName
    || (message && (typeof input.message !== "string" || !input.message.trim()))) {
    return { allowed: false, reason: "AUDIT_CONTROL_TARGET_FORBIDDEN" };
  }
  return { allowed: true, reason: null };
}
