import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  authorizeAntigravityLeaseCapability,
  resolveAntigravityAuthorityMode,
} from "../skills/orchestra/work-lease-authority.mjs";
import { normalizeToolEvent } from "../skills/orchestra/provider/antigravity/adapter/tool-event.mjs";
import { authorizeCapability } from "../skills/orchestra/core/policy/capability-authorization.mjs";
import { authorizeMutation } from "../skills/orchestra/core/policy/mutation-authorization.mjs";

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

function activePacket(repoRoot) {
  const state = readJson(resolve(repoRoot, ".agents/state/active-state.json"), {}) || {};
  return state.implementationPacket
    || state.implementation_packet
    || state.directWork?.implementationPacket
    || state.direct_work?.implementation_packet
    || null;
}

function deny(reason) {
  console.log(JSON.stringify({ decision: "deny", reason }));
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
  const bindings = readJson(resolve(repoRoot, ".agents/state/role-bindings.json"), {}) || {};
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

  const control = authorizeAntigravityLeaseCapability(repoRoot, {
    conversationId: convId,
    capability: "CONTROL",
    mode,
  });
  if (!control.allowed) {
    deny(
      `ORCHESTRA_WORK_LEASE_AUTHORITY_DENIED:${control.reason || "UNKNOWN"}. `
      + "This root conversation does not hold the current generation-fenced Work Lease. Continue in the current root conversation.",
    );
    return;
  }

  let event;
  try {
    event = normalizeToolEvent(payload);
  } catch (error) {
    deny(`ORCHESTRA_PROVIDER_EVENT_DENIED:${error?.message || "INVALID_PROVIDER_EVENT"}`);
    return;
  }
  if (event.eventType === "UNKNOWN" || event.operation === "UNKNOWN") {
    deny("ORCHESTRA_PROVIDER_EVENT_DENIED:UNKNOWN_OPERATION");
    return;
  }

  const packet = activePacket(repoRoot);
  const actor = control.lease?.actor;
  if (packet && event.operation === "READ") {
    const readDecision = authorizeCapability({
      actor,
      lease: control.lease,
      packet,
      operation: "READ",
      capability: "CONTROL",
    });
    if (!readDecision.allowed) {
      deny(`ORCHESTRA_CAPABILITY_DENIED:${readDecision.reason}`);
      return;
    }
  }

  if (event.operation === "WRITE" || event.operation === "COMMAND") {
    const mutationLease = authorizeAntigravityLeaseCapability(repoRoot, {
      conversationId: convId,
      generation: control.lease.generation,
      capability: "WORKSPACE_EDIT",
      mode,
    });
    if (!mutationLease.allowed) {
      deny(`ORCHESTRA_WORK_LEASE_AUTHORITY_DENIED:${mutationLease.reason || "UNKNOWN"}`);
      return;
    }
    const lease = mutationLease.lease;
    const mutationDecision = authorizeMutation({
      actor: lease.actor,
      lease,
      generation: lease.generation,
      workspace: { workspaceId: lease.workspaceId },
      operation: "WRITE",
    });
    if (!mutationDecision.allowed) {
      deny(`ORCHESTRA_MUTATION_DENIED:${mutationDecision.reason}`);
      return;
    }
    if (packet) {
      const capabilityDecision = authorizeCapability({
        actor: lease.actor,
        lease,
        packet,
        operation: "WRITE",
        capability: "WORKSPACE_EDIT",
      });
      if (!capabilityDecision.allowed) {
        deny(`ORCHESTRA_CAPABILITY_DENIED:${capabilityDecision.reason}`);
        return;
      }
    }
  }

  delegate(rawInput);
}

main();
