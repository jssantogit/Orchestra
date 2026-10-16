import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { authorizeLeaseMutation } from "./core/leases/lease-authorizer.mjs";
import { readWorkLease } from "./core/leases/work-lease-store.mjs";

const DIAGNOSTIC_SCHEMA = "orchestra.codex-work-lease-diagnostic.v1";
const BINDINGS_SCHEMA = "orchestra.codex-work-lease-bindings.v1";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function actorFor(sessionId) {
  const sid = clean(sessionId, 300);
  if (!sid) return null;
  return { provider: "codex", sessionIdHash: `sha256:${digest(sid)}` };
}

function inspectBindings(repoRoot) {
  const path = join(repoRoot, ".codex", "orchestra-state", "work-lease-session-bindings.json");
  if (!existsSync(path)) {
    return {
      exists: false,
      valid: true,
      reason: null,
      count: 0,
      path,
      value: { schema: BINDINGS_SCHEMA, bindings: {} },
    };
  }

  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const valid = Boolean(
      value
      && value.schema === BINDINGS_SCHEMA
      && value.bindings
      && typeof value.bindings === "object"
      && !Array.isArray(value.bindings),
    );
    if (!valid) {
      return { exists: true, valid: false, reason: "LEASE_BINDINGS_INVALID", count: 0, path, value: null };
    }
    return {
      exists: true,
      valid: true,
      reason: null,
      count: Object.keys(value.bindings).length,
      path,
      value,
    };
  } catch {
    return { exists: true, valid: false, reason: "LEASE_BINDINGS_INVALID", count: 0, path, value: null };
  }
}

function leaseSnapshot(current) {
  const lease = current.lease || null;
  return {
    exists: Boolean(current.exists),
    valid: Boolean(current.valid),
    reason: current.reason || null,
    path: current.path || null,
    generation: Number.isInteger(lease?.generation) ? lease.generation : null,
    workspaceId: lease?.workspaceId || null,
    taskId: lease?.taskId || null,
    state: lease?.state || null,
    actor: lease?.actor || null,
    capabilities: Array.isArray(lease?.capabilities) ? [...lease.capabilities] : [],
    candidate: lease?.candidate ?? null,
  };
}

function bindingsSnapshot(current) {
  return {
    exists: Boolean(current.exists),
    valid: Boolean(current.valid),
    reason: current.reason || null,
    count: current.count || 0,
    path: current.path || null,
  };
}

function unresolvedAuthority() {
  return {
    resolved: false,
    allowed: null,
    reason: "CODEX_SESSION_ID_NOT_PROVIDED",
    bindingGeneration: null,
  };
}

function semanticResult({ status, reason, lease, bindings, authority }) {
  return {
    schema: DIAGNOSTIC_SCHEMA,
    completed: true,
    status,
    reason: reason || null,
    lease: leaseSnapshot(lease),
    bindings: bindingsSnapshot(bindings),
    authority,
  };
}

export function inspectCodexWorkLease(repoRoot, { sessionId = null } = {}) {
  try {
    const lease = readWorkLease(repoRoot);
    const bindings = inspectBindings(repoRoot);

    if (!lease.valid) {
      return semanticResult({
        status: "INVALID",
        reason: lease.reason || "LEASE_SCHEMA_INVALID",
        lease,
        bindings,
        authority: unresolvedAuthority(),
      });
    }

    if (!bindings.valid) {
      return semanticResult({
        status: "INVALID",
        reason: bindings.reason || "LEASE_BINDINGS_INVALID",
        lease,
        bindings,
        authority: unresolvedAuthority(),
      });
    }

    if (!lease.exists || !lease.lease) {
      return semanticResult({
        status: "MISSING",
        reason: "WORK_LEASE_NOT_INITIALIZED",
        lease,
        bindings,
        authority: unresolvedAuthority(),
      });
    }

    const actor = actorFor(sessionId);
    if (!actor) {
      return semanticResult({
        status: "READY",
        reason: null,
        lease,
        bindings,
        authority: unresolvedAuthority(),
      });
    }

    const binding = bindings.value.bindings[actor.sessionIdHash] || null;
    if (!binding) {
      return semanticResult({
        status: "DENIED",
        reason: "LEASE_BINDING_MISSING",
        lease,
        bindings,
        authority: {
          resolved: true,
          allowed: false,
          reason: "LEASE_BINDING_MISSING",
          bindingGeneration: null,
        },
      });
    }

    const decision = authorizeLeaseMutation({
      lease: lease.lease,
      actor,
      generation: binding.generation,
      capability: "CONTROL",
    });
    const reason = decision.allowed
      ? null
      : (binding.generation !== lease.lease.generation ? "STALE_WORK_LEASE" : decision.reason || "WORK_LEASE_AUTHORITY_DENIED");

    return semanticResult({
      status: decision.allowed ? "AUTHORIZED" : "DENIED",
      reason,
      lease,
      bindings,
      authority: {
        resolved: true,
        allowed: Boolean(decision.allowed),
        reason,
        bindingGeneration: Number.isInteger(binding.generation) ? binding.generation : null,
      },
    });
  } catch (error) {
    return {
      schema: DIAGNOSTIC_SCHEMA,
      completed: false,
      status: "ERROR",
      reason: "WORK_LEASE_DIAGNOSTIC_RUNTIME_ERROR",
      lease: null,
      bindings: null,
      authority: {
        resolved: false,
        allowed: null,
        reason: "WORK_LEASE_DIAGNOSTIC_RUNTIME_ERROR",
        bindingGeneration: null,
      },
      error: {
        code: clean(error?.code || "WORK_LEASE_DIAGNOSTIC_RUNTIME_ERROR", 160),
        message: clean(error?.message || error, 1000),
      },
    };
  }
}

export function formatCodexWorkLeaseInspection(result) {
  const lines = [
    "Orchestra Codex Work Lease",
    `Status:               ${result.status}`,
    `Reason:               ${result.reason || "none"}`,
    `Inspection completed: ${result.completed ? "yes" : "no"}`,
  ];

  if (result.lease) {
    lines.push(`Lease file:            ${result.lease.exists ? "present" : "absent"}`);
    lines.push(`Lease valid:           ${result.lease.valid ? "yes" : "no"}`);
    lines.push(`Generation:            ${result.lease.generation ?? "none"}`);
    lines.push(`Lease state:           ${result.lease.state || "none"}`);
    lines.push(`Task:                  ${result.lease.taskId || "none"}`);
  }
  if (result.bindings) {
    lines.push(`Bindings file:         ${result.bindings.exists ? "present" : "absent"}`);
    lines.push(`Bindings valid:        ${result.bindings.valid ? "yes" : "no"}`);
    lines.push(`Binding count:         ${result.bindings.count}`);
  }
  if (result.authority) {
    lines.push(`Authority resolved:    ${result.authority.resolved ? "yes" : "no"}`);
    lines.push(`CONTROL allowed:       ${result.authority.allowed === null ? "unknown" : (result.authority.allowed ? "yes" : "no")}`);
    lines.push(`Authority reason:      ${result.authority.reason || "none"}`);
  }
  if (result.error) lines.push(`Runtime error:         ${result.error.code}: ${result.error.message}`);
  return lines.join("\n");
}
