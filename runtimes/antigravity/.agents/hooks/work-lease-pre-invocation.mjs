import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  enterAntigravityWorkLease,
  resolveAntigravityAuthorityMode,
} from "../skills/orchestra/work-lease-authority.mjs";

const legacyHook = resolve(dirname(fileURLToPath(import.meta.url)), "pre-invocation-guard.mjs");

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

function updateCompatibilityProjection(repoRoot, payload, lease) {
  const statePath = resolve(repoRoot, ".agents/state/active-state.json");
  const roleBindingsPath = resolve(repoRoot, ".agents/state/role-bindings.json");
  const convId = payload.conversationId;

  const roleBindings = readJson(roleBindingsPath, {
    mainConversationId: null,
    bindings: {},
    conversations: {},
    pendingSubagents: [],
  });
  if (!roleBindings || typeof roleBindings !== "object" || Array.isArray(roleBindings)) {
    return { ok: false, reason: "ROLE_BINDINGS_INVALID" };
  }
  if (!roleBindings.bindings || typeof roleBindings.bindings !== "object" || Array.isArray(roleBindings.bindings)) roleBindings.bindings = {};
  if (!roleBindings.conversations || typeof roleBindings.conversations !== "object" || Array.isArray(roleBindings.conversations)) roleBindings.conversations = {};
  if (!Array.isArray(roleBindings.pendingSubagents)) roleBindings.pendingSubagents = [];

  const previousMain = roleBindings.mainConversationId || null;
  if (previousMain && previousMain !== convId) {
    const previous = roleBindings.bindings[previousMain] || roleBindings.conversations[previousMain] || {};
    const former = {
      ...previous,
      conversationId: previousMain,
      role: "FORMER_ORCHESTRATOR",
      authorityStatus: "TRANSFERRED",
      transferredAt: new Date().toISOString(),
      source: previous.source || "WORK_LEASE_PROVENANCE",
    };
    roleBindings.bindings[previousMain] = former;
    roleBindings.conversations[previousMain] = former;
  }

  const record = {
    ...(roleBindings.bindings[convId] || roleBindings.conversations[convId] || {}),
    conversationId: convId,
    role: "ORCHESTRATOR",
    profile: "flash-orchestrator",
    model: payload.modelName || "gemini-3.8-flash-medium",
    source: "WORK_LEASE_PROVENANCE",
    confidence: "HIGH",
    authorityStatus: "ACTIVE",
    workLeaseGeneration: lease.generation,
  };
  roleBindings.mainConversationId = convId;
  roleBindings.bindings[convId] = record;
  roleBindings.conversations[convId] = record;
  mkdirSync(dirname(roleBindingsPath), { recursive: true });
  writeFileSync(roleBindingsPath, JSON.stringify(roleBindings, null, 2) + "\n", "utf8");

  const state = readJson(statePath, {});
  if (state && typeof state === "object" && !Array.isArray(state)) {
    state.conversationId = convId;
    state.activeRole = "ORCHESTRATOR";
    state.agentProfile = "flash-orchestrator";
    state.workLeaseGeneration = lease.generation;
    state.workLeaseCandidate = lease.candidate ?? null;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  }
  return { ok: true, previousMain };
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

  const rootCandidate = !payload.parentConversationId
    && !payload.parent_conversation_id
    && !["WORKER", "REVIEWER"].includes(String(payload.agentRole || payload.role || "").toUpperCase());
  if (!rootCandidate) {
    delegate(rawInput);
    return;
  }

  const repoRoot = repoRootFrom(payload);
  const entered = enterAntigravityWorkLease(repoRoot, {
    conversationId: payload.conversationId || null,
    parentConversationId: payload.parentConversationId || payload.parent_conversation_id || null,
    role: payload.agentRole || payload.role || null,
    profile: payload.agentProfile || payload.profile || "flash-orchestrator",
    mode,
  });

  if (!entered.authoritative) {
    console.log(JSON.stringify({
      injectSteps: [{
        ephemeralMessage:
          `ORCHESTRA WORK LEASE AUTHORITY DENIED [${String(mode).toUpperCase()}]: ${entered.reason || "WORK_LEASE_DENIED"}. `
          + "This root conversation is not the current generation owner. Do not execute project tools from this conversation.",
      }],
    }));
    return;
  }

  const projection = updateCompatibilityProjection(repoRoot, payload, entered.lease);
  if (!projection.ok) {
    console.log(JSON.stringify({
      injectSteps: [{ ephemeralMessage: `ORCHESTRA WORK LEASE COMPATIBILITY STATE INVALID: ${projection.reason}. Tool execution must fail closed.` }],
    }));
    return;
  }

  const result = spawnSync(process.execPath, [legacyHook], {
    cwd: process.cwd(),
    input: rawInput,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    process.exitCode = result.status ?? 2;
    return;
  }

  let output = { injectSteps: [] };
  try { output = JSON.parse(result.stdout || "{}"); } catch {
    process.stdout.write(result.stdout || "");
    return;
  }
  if (!Array.isArray(output.injectSteps)) output.injectSteps = [];
  output.injectSteps.unshift({
    ephemeralMessage:
      `ORCHESTRA WORK LEASE AUTHORITY [${String(mode).toUpperCase()}]: generation=${entered.lease.generation}; `
      + `task=${entered.lease.taskId}; candidate=${entered.lease.candidate || "none"}. `
      + "conversationId is provenance; the generation-fenced Work Lease is root authority. Manual orchestrator handoff is recovery-only.",
  });
  console.log(JSON.stringify(output));
}

main();
