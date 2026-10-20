#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGlobalProjectRegistry,
  globalRegistryStateExists,
  resolveOrchestraHome,
} from "./project-registry.mjs";
import { createGlobalOperationReconciler } from "./reconciliation.mjs";
import { createCodexHookHandler } from "../providers/codex/hook-handler.mjs";
import { normalizeCodexActor } from "../providers/codex/actor.mjs";
import { createAntigravityHookHandler } from "../providers/antigravity/hook-handler.mjs";
import { normalizeAntigravityActor } from "../providers/antigravity/actor.mjs";
import { installCodexV2Shim } from "../providers/codex/shim-manager.mjs";
import { createRuntimeImageManager } from "../runtime-images/manager.mjs";
import { loadRuntimeImageSource } from "../runtime-images/source.mjs";
import { createRuntimeImageStore } from "../runtime-images/store.mjs";
import { inventoryLegacyProject } from "../migration/inventory.mjs";
import { classifyLegacyInventoryEntry } from "../migration/transient-classifier.mjs";
import { createLegacyMigrationImporter } from "../migration/import.mjs";
import { createMigrationLifecycleStore } from "../migration/rollback.mjs";
import { createMigrationCleanup } from "../migration/cleanup.mjs";

const V2_ENGINE_COMPATIBILITY_VERSION = "2.0.0";
const V2_PROVIDER_ADAPTER_VERSIONS = Object.freeze({
  codex: "2.0.0",
  antigravity: "2.0.0",
});
const MIGRATION_COMPAT_RUNTIME_IMAGE = "legacy-migration-compat";

function cliError(code, message, fields = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, fields);
  return error;
}

function usage(message) {
  throw cliError("ORCHESTRA_V2_CLI_USAGE", message);
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    if (!["home", "runtime-image", "instruction-epoch", "trust", "command-id", "action"].includes(name)) {
      usage(`Unknown option: ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`Missing value for ${token}`);
    options[name] = value;
    index += 1;
  }

  return { positionals, options };
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function explicitHome(options, env) {
  return options.home || env.ORCHESTRA_HOME || resolveOrchestraHome({ env });
}

function parseInstructionEpoch(value) {
  if (value === undefined) usage("--instruction-epoch is required");
  if (!/^\d+$/.test(value)) usage("--instruction-epoch must be a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) usage("--instruction-epoch must be a safe integer");
  return parsed;
}

function parseDirtyAction(value) {
  if (value === undefined) usage("--action is required");
  const action = String(value).trim().toUpperCase();
  if (!["PRESERVE", "DISCARD"].includes(action)) {
    usage("--action must be preserve or discard");
  }
  return action;
}

function validateCommand({ positionals, options }) {
  const command = positionals[0];

  if (command === "home") {
    if (positionals.length !== 1) usage("Usage: orchestra home [--home <path>]");
    return Object.freeze({ kind: "HOME" });
  }

  if (command === "runtime" && positionals[1] === "list") {
    if (positionals.length !== 2) usage("Usage: orchestra runtime list");
    return Object.freeze({ kind: "RUNTIME_LIST" });
  }

  if (command === "runtime" && positionals[1] === "install") {
    if (positionals.length !== 3) usage("Usage: orchestra runtime install <source>");
    return Object.freeze({ kind: "RUNTIME_INSTALL", source: positionals[2] });
  }

  if (command === "register") {
    if (positionals.length > 2) {
      usage("Usage: orchestra register [workspace] --runtime-image <version> --instruction-epoch <n> --trust <mode>");
    }
    if (!options["runtime-image"]) usage("--runtime-image is required");
    if (!options.trust) usage("--trust is required");
    return Object.freeze({
      kind: "REGISTER",
      root: positionals[1] || null,
      runtimeImage: options["runtime-image"],
      instructionEpoch: parseInstructionEpoch(options["instruction-epoch"]),
      trustMode: options.trust,
    });
  }

  if (command === "project" && positionals[1] === "status") {
    if (positionals.length > 3) usage("Usage: orchestra project status [workspace|projectId]");
    return Object.freeze({ kind: "PROJECT_STATUS", target: positionals[2] || null });
  }

  if (command === "project" && positionals[1] === "migrate") {
    const action = positionals[2];
    if (action === "inspect") {
      if (positionals.length !== 4) usage("Usage: orchestra project migrate inspect <workspace>");
      return Object.freeze({ kind: "PROJECT_MIGRATE_INSPECT", workspace: positionals[3] });
    }
    if (action === "apply") {
      if (positionals.length !== 4) usage("Usage: orchestra project migrate apply <workspace> --command-id <id>");
      if (!options["command-id"]) usage("--command-id is required");
      return Object.freeze({
        kind: "PROJECT_MIGRATE_APPLY",
        workspace: positionals[3],
        commandId: options["command-id"],
      });
    }
    if (action === "rollback") {
      if (positionals.length !== 4) usage("Usage: orchestra project migrate rollback <projectId> --command-id <id>");
      if (!options["command-id"]) usage("--command-id is required");
      return Object.freeze({
        kind: "PROJECT_MIGRATE_ROLLBACK",
        projectId: positionals[3],
        commandId: options["command-id"],
      });
    }
    if (action === "cleanup") {
      if (positionals.length !== 4) usage("Usage: orchestra project migrate cleanup <projectId> --command-id <id>");
      if (!options["command-id"]) usage("--command-id is required");
      return Object.freeze({
        kind: "PROJECT_MIGRATE_CLEANUP",
        projectId: positionals[3],
        commandId: options["command-id"],
      });
    }
    usage("Usage: orchestra project migrate <inspect|apply|rollback|cleanup> ...");
  }

  if (command === "project" && ["upgrade", "rollback"].includes(positionals[1])) {
    if (positionals.length !== 3) {
      usage(`Usage: orchestra project ${positionals[1]} <projectId> --runtime-image <imageId> --command-id <id>`);
    }
    if (!options["runtime-image"]) usage("--runtime-image is required");
    if (!options["command-id"]) usage("--command-id is required");
    return Object.freeze({
      kind: positionals[1] === "upgrade" ? "PROJECT_UPGRADE" : "PROJECT_ROLLBACK",
      projectId: positionals[2],
      runtimeImage: options["runtime-image"],
      commandId: options["command-id"],
    });
  }

  if (command === "project" && positionals[1] === "recover") {
    if (positionals.length !== 4) {
      usage("Usage: orchestra project recover <projectId> <operationId> --command-id <id>");
    }
    if (!options["command-id"]) usage("--command-id is required");
    return Object.freeze({
      kind: "PROJECT_RECOVER",
      projectId: positionals[2],
      operationId: positionals[3],
      commandId: options["command-id"],
    });
  }

  if (command === "project" && positionals[1] === "resolve-dirty") {
    if (positionals.length !== 4) {
      usage("Usage: orchestra project resolve-dirty <projectId> <operationId> --action <preserve|discard> --command-id <id>");
    }
    if (!options["command-id"]) usage("--command-id is required");
    return Object.freeze({
      kind: "PROJECT_RESOLVE_DIRTY",
      projectId: positionals[2],
      operationId: positionals[3],
      action: parseDirtyAction(options.action),
      commandId: options["command-id"],
    });
  }

  if (command === "project" && positionals[1] === "rebind") {
    if (positionals.length !== 4) usage("Usage: orchestra project rebind <projectId> <newWorkspace>");
    return Object.freeze({
      kind: "PROJECT_REBIND",
      projectId: positionals[2],
      newRoot: positionals[3],
    });
  }

  if (command === "provider" && positionals[1] === "codex" && positionals[2] === "hook") {
    if (positionals.length !== 3) usage("Usage: orchestra provider codex hook");
    return Object.freeze({ kind: "CODEX_HOOK" });
  }

  if (command === "provider" && positionals[1] === "antigravity" && positionals[2] === "hook") {
    if (positionals.length !== 3) usage("Usage: orchestra provider antigravity hook");
    return Object.freeze({ kind: "ANTIGRAVITY_HOOK" });
  }

  if (command === "provider" && positionals[1] === "codex" && positionals[2] === "shim"
    && positionals[3] === "install") {
    if (positionals.length !== 4) usage("Usage: orchestra provider codex shim install");
    return Object.freeze({ kind: "CODEX_SHIM_INSTALL" });
  }

  usage("Usage: orchestra <home|runtime install|runtime list|register|project status|project migrate inspect|project migrate apply|project migrate rollback|project migrate cleanup|project upgrade|project rollback|project recover|project resolve-dirty|project rebind|provider codex hook|provider codex shim install|provider antigravity hook> ...");
}

function notRegisteredResult() {
  return {
    exitCode: 1,
    payload: { ok: false, reason: "PROJECT_NOT_REGISTERED", registered: false },
  };
}

async function runtimeImagesExist(home) {
  try {
    await access(join(home, "runtime-images"));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function runRuntimeCommand({ command, home, cwd }) {
  if (command.kind === "RUNTIME_LIST") {
    if (!(await runtimeImagesExist(home))) {
      return { exitCode: 0, payload: { ok: true, images: [] } };
    }
    const imageStore = createRuntimeImageStore({ orchestraHome: home });
    return { exitCode: 0, payload: { ok: true, images: await imageStore.list() } };
  }

  const source = await loadRuntimeImageSource(resolve(cwd, command.source));
  const imageStore = createRuntimeImageStore({ orchestraHome: home });
  const image = await imageStore.install(source);
  const verification = await imageStore.verify(image.imageId);
  if (!verification.valid) {
    throw cliError(
      "ORCHESTRA_RUNTIME_IMAGE_INTEGRITY_FAILED",
      `Installed runtime image failed verification: ${image.imageId}`,
      { imageId: image.imageId },
    );
  }
  return { exitCode: 0, payload: { ok: true, image, verification } };
}

async function runProjectRuntimeChange({ command, home }) {
  if (!(await globalRegistryStateExists({ home }))) {
    return { exitCode: 1, payload: { ok: false, reason: "PROJECT_NOT_FOUND" } };
  }
  const registry = createGlobalProjectRegistry({ home });
  try {
    const imageStore = createRuntimeImageStore({ orchestraHome: home });
    const statusReconciler = createGlobalOperationReconciler({
      state: registry.state,
      home,
    });
    const manager = createRuntimeImageManager({
      state: registry.state,
      imageStore,
      statusReconciler,
      engineVersion: V2_ENGINE_COMPATIBILITY_VERSION,
      providerAdapterVersions: V2_PROVIDER_ADAPTER_VERSIONS,
    });
    const input = {
      projectId: command.projectId,
      targetImageId: command.runtimeImage,
      commandId: command.commandId,
    };
    const result = command.kind === "PROJECT_UPGRADE"
      ? await manager.upgradeProject(input)
      : await manager.rollbackProject(input);
    if (!result.ok) return { exitCode: 1, payload: result };
    return {
      exitCode: 0,
      payload: {
        ...result,
        oldPin: result.previousImageId,
        newPin: result.targetImageId,
        instructionEpoch: result.project.runtime.instructionEpoch,
      },
    };
  } finally {
    registry.close();
  }
}

function migrationEntryPath(workspaceRoot, entry) {
  return join(workspaceRoot, ...entry.path.split("/"));
}

async function readMigrationEntry(workspaceRoot, entry) {
  let bytes = null;
  let record = null;
  try {
    bytes = await readFile(migrationEntryPath(workspaceRoot, entry));
    if (entry.integrity === "PARSED" && entry.path.endsWith(".json")) {
      record = JSON.parse(bytes.toString("utf8"));
    }
  } catch {
    record = null;
  }
  return { bytes, record };
}

function migrationFacts(entry, record) {
  if (entry.category === "DURABLE_LEGACY_STATE") {
    return {
      provenanceComplete: Boolean(record && record.schema === entry.schema),
      unresolvedTransientAuthority: false,
    };
  }
  if (!["TRANSIENT_PARALLEL_GROUP", "TRANSIENT_LEGACY_STATE", "PROVIDER_LEGACY_STATE", "MANAGED_RUNTIME"].includes(entry.category)) {
    return {};
  }
  const source = record && typeof record === "object" ? record : {};
  const embedded = source.facts && typeof source.facts === "object" ? source.facts : {};
  return {
    persistedState: embedded.persistedState ?? source.state ?? source.workflowState ?? null,
    runtimeVersion: embedded.runtimeVersion ?? source.runtimeVersion ?? source.orchestraVersion ?? null,
    ownerProcessProof: embedded.ownerProcessProof ?? source.ownerProcessProof ?? "UNKNOWN",
    survivingWorkspaces: Number.isInteger(embedded.survivingWorkspaces)
      ? embedded.survivingWorkspaces
      : Number.isInteger(source.survivingWorkspaces) ? source.survivingWorkspaces : 0,
    canonicalPromotion: embedded.canonicalPromotion === true || source.canonicalPromotion === true,
    workspaceIdentityProven: embedded.workspaceIdentityProven === true || source.workspaceIdentityProven === true,
    survivingWorkspaceRef: embedded.survivingWorkspaceRef ?? source.survivingWorkspaceRef ?? null,
    operationProvenanceComplete: embedded.operationProvenanceComplete === true || source.operationProvenanceComplete === true,
    operationKind: embedded.operationKind ?? source.operationKind ?? null,
    startedAt: embedded.startedAt ?? source.startedAt ?? null,
    heartbeatAt: embedded.heartbeatAt ?? source.heartbeatAt ?? null,
    deadlineAt: embedded.deadlineAt ?? source.deadlineAt ?? null,
    ownerProcess: embedded.ownerProcess ?? source.ownerProcess ?? null,
    ownerProofTokenHash: embedded.ownerProofTokenHash ?? source.ownerProofTokenHash ?? null,
  };
}

async function buildMigrationReport(workspace) {
  const inventoryResult = await inventoryLegacyProject({ workspace });
  const entryData = new Map();
  const classificationPairs = [];
  const classifications = [];
  for (const entry of inventoryResult.entries ?? []) {
    const data = await readMigrationEntry(inventoryResult.workspaceRoot ?? resolve(workspace), entry);
    const facts = migrationFacts(entry, data.record);
    const result = classifyLegacyInventoryEntry({ entry, facts });
    entryData.set(entry.path, { ...data, facts });
    classificationPairs.push({ path: entry.path, result });
    classifications.push({ path: entry.path, ...result });
  }
  return {
    ok: inventoryResult.ok,
    workspaceRoot: inventoryResult.workspaceRoot ?? resolve(workspace),
    inventory: inventoryResult.entries ?? [],
    issues: inventoryResult.issues ?? [],
    classifications,
    classificationPairs,
    entryData,
  };
}

function publicMigrationReport(report) {
  return {
    inventory: report.inventory,
    issues: report.issues,
    classifications: report.classifications,
  };
}

function migrationBlocked(report) {
  return !report.ok || report.classifications.some((item) => item.disposition === "UNSUPPORTED_BLOCKED");
}

function migrationPayload(report) {
  const privateArchives = [];
  const transientFacts = [];
  const candidates = [];
  const continuations = [];
  const evidence = [];

  for (const entry of report.inventory) {
    const classification = report.classifications.find((item) => item.path === entry.path);
    const data = report.entryData.get(entry.path);
    if (classification?.disposition === "PRIVATE_ARCHIVE" && data?.bytes) {
      privateArchives.push({ path: entry.path, bytes: data.bytes });
      continue;
    }
    if (classification?.disposition === "RECOVERABLE_IMPORT"
      && ["TRANSIENT_PARALLEL_GROUP", "TRANSIENT_LEGACY_STATE", "PROVIDER_LEGACY_STATE"].includes(entry.category)
      && data?.bytes) {
      transientFacts.push({
        path: entry.path,
        bytes: data.bytes,
        provenanceComplete: true,
        facts: data.facts,
      });
      continue;
    }
    if (classification?.disposition === "CLEAN_IMPORT" && data?.bytes) {
      const fact = { path: entry.path, bytes: data.bytes, provenanceComplete: true };
      if (entry.schema === "orchestra.candidate.v1") candidates.push(fact);
      else if (entry.schema === "orchestra.work-continuation.v1") continuations.push(fact);
      else if (entry.schema === "orchestra.evidence.v1") evidence.push(fact);
    }
  }

  const durableCount = candidates.length + continuations.length + evidence.length;
  if (durableCount > 0 && (candidates.length !== 1 || continuations.length !== 1)) {
    return { ok: false, code: "MIGRATION_DURABLE_SET_AMBIGUOUS" };
  }
  return {
    ok: true,
    privateArchives,
    transientFacts,
    durableFacts: durableCount > 0
      ? { candidate: candidates[0], evidence, continuation: continuations[0] }
      : {},
    hasImportableFacts: durableCount > 0 || privateArchives.length > 0 || transientFacts.length > 0,
  };
}

async function runMigrationCommand({ command, home }) {
  if (command.kind === "PROJECT_MIGRATE_INSPECT") {
    const report = await buildMigrationReport(command.workspace);
    return {
      exitCode: report.ok ? 0 : 1,
      payload: {
        ok: report.ok,
        code: report.ok ? "MIGRATION_INSPECTION_READY" : "MIGRATION_BLOCKED",
        ...publicMigrationReport(report),
      },
    };
  }

  if (command.kind === "PROJECT_MIGRATE_ROLLBACK") {
    if (!(await globalRegistryStateExists({ home }))) {
      return { exitCode: 1, payload: { ok: false, code: "MIGRATION_NOT_FOUND" } };
    }
    const registry = createGlobalProjectRegistry({ home });
    try {
      const store = createMigrationLifecycleStore({ home, state: registry.state });
      const result = await store.rollback({ projectId: command.projectId, commandId: command.commandId });
      return { exitCode: result.ok ? 0 : 1, payload: result };
    } finally {
      registry.close();
    }
  }

  if (command.kind === "PROJECT_MIGRATE_CLEANUP") {
    if (!(await globalRegistryStateExists({ home }))) {
      return { exitCode: 1, payload: { ok: false, code: "MIGRATION_NOT_FOUND" } };
    }
    const registry = createGlobalProjectRegistry({ home });
    try {
      const lifecycleStore = createMigrationLifecycleStore({ home, state: registry.state });
      const cleanup = createMigrationCleanup({ registry, lifecycleStore, home });
      const result = await cleanup.cleanup({
        projectId: command.projectId,
        commandId: command.commandId,
      });
      return { exitCode: result.ok ? 0 : 1, payload: result };
    } finally {
      registry.close();
    }
  }

  const report = await buildMigrationReport(command.workspace);
  if (migrationBlocked(report)) {
    return {
      exitCode: 1,
      payload: { ok: false, code: "MIGRATION_BLOCKED", ...publicMigrationReport(report) },
    };
  }
  const payload = migrationPayload(report);
  if (!payload.ok) {
    return {
      exitCode: 1,
      payload: { ok: false, code: payload.code, ...publicMigrationReport(report) },
    };
  }

  const registry = createGlobalProjectRegistry({ home });
  try {
    let importResult;
    if (payload.hasImportableFacts) {
      const importer = createLegacyMigrationImporter({ projectRegistry: registry });
      importResult = await importer.apply({
        workspace: report.workspaceRoot,
        commandId: command.commandId,
        runtimeImage: MIGRATION_COMPAT_RUNTIME_IMAGE,
        instructionEpoch: 0,
        trustMode: "migration",
        inventory: report.inventory,
        classifications: report.classificationPairs,
        durableFacts: payload.durableFacts,
        privateArchives: payload.privateArchives,
        transientFacts: payload.transientFacts,
      });
      if (!importResult.ok) {
        return { exitCode: 1, payload: { ...importResult, ...publicMigrationReport(report) } };
      }
    } else {
      const registered = await registry.registerWorkspace({
        root: report.workspaceRoot,
        runtimeImage: MIGRATION_COMPAT_RUNTIME_IMAGE,
        instructionEpoch: 0,
        trustMode: "migration",
      });
      if (!registered.ok) return { exitCode: 1, payload: registered };
      importResult = {
        ok: true,
        project: registered.project,
        work: null,
        recoveryWork: null,
        transient: [],
        archives: [],
        replayed: registered.replayed === true,
      };
    }

    const store = createMigrationLifecycleStore({ home, state: registry.state });
    const recorded = await store.recordApply({
      project: importResult.project,
      workspace: report.workspaceRoot,
      commandId: command.commandId,
      inventory: report.inventory,
      classifications: report.classifications,
      importResult,
    });
    if (!recorded.ok) return { exitCode: 1, payload: recorded };
    return {
      exitCode: 0,
      payload: {
        ok: true,
        code: "MIGRATION_APPLIED",
        project: importResult.project,
        manifest: recorded.manifest,
        replayed: recorded.replayed === true,
      },
    };
  } finally {
    registry.close();
  }
}

async function runRegistryCommand({ positionals, options, cwd, env }) {
  const home = explicitHome(options, env);
  const command = validateCommand({ positionals, options });

  if (command.kind === "HOME") {
    return { exitCode: 0, payload: { ok: true, home } };
  }

  if (["RUNTIME_LIST", "RUNTIME_INSTALL"].includes(command.kind)) {
    return runRuntimeCommand({ command, home, cwd });
  }

  if (["PROJECT_MIGRATE_INSPECT", "PROJECT_MIGRATE_APPLY", "PROJECT_MIGRATE_ROLLBACK", "PROJECT_MIGRATE_CLEANUP"].includes(command.kind)) {
    return runMigrationCommand({ command, home });
  }

  if (["PROJECT_UPGRADE", "PROJECT_ROLLBACK"].includes(command.kind)) {
    return runProjectRuntimeChange({ command, home });
  }

  if (["PROJECT_STATUS", "PROJECT_RECOVER", "PROJECT_RESOLVE_DIRTY"].includes(command.kind)
    && !(await globalRegistryStateExists({ home }))) {
    return notRegisteredResult();
  }

  const registry = createGlobalProjectRegistry({ home });
  try {
    if (command.kind === "REGISTER") {
      const result = await registry.registerWorkspace({
        root: command.root || cwd,
        runtimeImage: command.runtimeImage,
        instructionEpoch: command.instructionEpoch,
        trustMode: command.trustMode,
      });
      return { exitCode: result.ok ? 0 : 1, payload: result };
    }

    if (command.kind === "PROJECT_STATUS") {
      const target = command.target || cwd;
      const project = target.startsWith("prj_")
        ? registry.inspect(target)
        : await registry.resolveWorkspace(target);
      if (!project) return notRegisteredResult();

      const reconciler = createGlobalOperationReconciler({
        state: registry.state,
        home,
      });
      const inspection = await reconciler.inspect({ projectId: project.projectId });
      if (!inspection.ok) {
        return {
          exitCode: 1,
          payload: {
            ok: false,
            reason: inspection.reason,
            registered: true,
            project,
          },
        };
      }

      return {
        exitCode: 0,
        payload: {
          ok: true,
          registered: true,
          project,
          reconciliation: {
            work: inspection.work,
            operations: inspection.operations,
          },
        },
      };
    }

    if (command.kind === "PROJECT_RECOVER") {
      const reconciler = createGlobalOperationReconciler({
        state: registry.state,
        home,
      });
      const result = await reconciler.recover({
        projectId: command.projectId,
        operationId: command.operationId,
        commandId: command.commandId,
      });
      return { exitCode: result.ok ? 0 : 1, payload: result };
    }

    if (command.kind === "PROJECT_RESOLVE_DIRTY") {
      const reconciler = createGlobalOperationReconciler({
        state: registry.state,
        home,
      });
      const result = await reconciler.resolveDirty({
        projectId: command.projectId,
        operationId: command.operationId,
        action: command.action,
        commandId: command.commandId,
      });
      return { exitCode: result.ok ? 0 : 1, payload: result };
    }

    const result = await registry.rebindWorkspace({
      projectId: command.projectId,
      newRoot: command.newRoot,
    });
    return { exitCode: result.ok ? 0 : 1, payload: result };
  } finally {
    registry.close();
  }
}

async function readHookPayload(stdin, invalidReason = "CODEX_HOOK_PAYLOAD_INVALID") {
  let input = "";
  for await (const chunk of stdin) input += chunk.toString();
  if (!input.trim()) return { ok: false, reason: invalidReason };
  try {
    const payload = JSON.parse(input);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, reason: invalidReason };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: invalidReason };
  }
}

function isAntigravitySessionStart(payload) {
  return payload.hook_event_name === "SessionStart"
    || payload.hookEventName === "SessionStart"
    || payload.eventType === "SessionStart";
}

function isAntigravityPreToolUse(payload) {
  return payload.hook_event_name === "PreToolUse"
    || payload.hookEventName === "PreToolUse"
    || payload.eventType === "PreToolUse"
    || payload.eventType === "BeforeTool";
}

async function staleProviderObservation({ registry, provider, payload, cwd, normalizeActor }) {
  let project;
  let actor;
  try {
    project = await registry.resolveWorkspace(
      typeof payload.cwd === "string" && payload.cwd.trim().length > 0 ? payload.cwd : cwd,
    );
    actor = normalizeActor(payload);
  } catch {
    return null;
  }
  if (!project) return null;
  const observation = registry.state.sessionObservations.get({
    provider,
    projectId: project.projectId,
    actorIdHash: actor.actorIdHash,
  });
  if (!observation || observation.observedInstructionEpoch === project.runtime.instructionEpoch) return null;

  const diagnostic = {
    reason: "SESSION_RUNTIME_STALE",
    projectId: project.projectId,
    currentInstructionEpoch: project.runtime.instructionEpoch,
  };
  return {
    ok: false,
    ...diagnostic,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: JSON.stringify(diagnostic),
    },
  };
}

async function runCodexHook({ home, cwd, stdin }) {
  const decoded = await readHookPayload(stdin);
  if (!decoded.ok) return { exitCode: 1, payload: decoded };
  if (!(await globalRegistryStateExists({ home }))) {
    const payload = { ok: false, reason: "PROJECT_NOT_REGISTERED", registered: false };
    if (decoded.payload.hook_event_name === "PreToolUse") {
      payload.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "PROJECT_NOT_REGISTERED",
      };
    } else if (decoded.payload.hook_event_name === "SessionStart") {
      payload.hookSpecificOutput = {
        hookEventName: "SessionStart",
        additionalContext: "PROJECT_NOT_REGISTERED",
      };
    } else if (decoded.payload.hook_event_name === "PostToolUse") {
      payload.hookSpecificOutput = { hookEventName: "PostToolUse" };
    }
    return { exitCode: 1, payload };
  }
  const registry = createGlobalProjectRegistry({ home });
  try {
    if (decoded.payload.hook_event_name === "PreToolUse") {
      const stale = await staleProviderObservation({
        registry,
        provider: "codex",
        payload: decoded.payload,
        cwd,
        normalizeActor: normalizeCodexActor,
      });
      if (stale) return { exitCode: 1, payload: stale };
    }
    const handler = createCodexHookHandler({ registry });
    const payload = await handler.handle(decoded.payload, { cwd });
    return { exitCode: payload.ok ? 0 : 1, payload };
  } finally {
    registry.close();
  }
}

async function runAntigravityHook({ home, cwd, stdin }) {
  const decoded = await readHookPayload(stdin, "ANTIGRAVITY_HOOK_PAYLOAD_INVALID");
  if (!decoded.ok) return { exitCode: 1, payload: decoded };
  if (!(await globalRegistryStateExists({ home }))) {
    const payload = { ok: false, reason: "PROJECT_NOT_REGISTERED", registered: false };
    if (isAntigravitySessionStart(decoded.payload)) {
      payload.hookSpecificOutput = {
        hookEventName: "SessionStart",
        additionalContext: "PROJECT_NOT_REGISTERED",
      };
    }
    return { exitCode: 1, payload };
  }
  const registry = createGlobalProjectRegistry({ home });
  try {
    if (isAntigravityPreToolUse(decoded.payload)) {
      const stale = await staleProviderObservation({
        registry,
        provider: "antigravity",
        payload: decoded.payload,
        cwd,
        normalizeActor: normalizeAntigravityActor,
      });
      if (stale) return { exitCode: 1, payload: stale };
    }
    const handler = createAntigravityHookHandler({ registry });
    const payload = await handler.handle(decoded.payload, { cwd });
    return { exitCode: payload.ok ? 0 : 1, payload };
  } finally {
    registry.close();
  }
}

async function runCodexShimInstall({ home, cwd, launcherPath, nodePath }) {
  if (!(await globalRegistryStateExists({ home }))) return notRegisteredResult();
  const registry = createGlobalProjectRegistry({ home });
  try {
    const project = await registry.resolveWorkspace(cwd);
    if (!project) return notRegisteredResult();
    const installed = installCodexV2Shim({
      targetDir: project.workspace.canonicalRoot,
      launcherPath,
      nodePath,
      orchestraHome: home,
    });
    return { exitCode: 0, payload: installed };
  } finally {
    registry.close();
  }
}

export async function runGlobalCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const parsed = parseArgs(argv);
    const command = validateCommand(parsed);
    const home = explicitHome(parsed.options, env);
    const result = command.kind === "CODEX_HOOK"
      ? await runCodexHook({ home, cwd, stdin })
      : command.kind === "ANTIGRAVITY_HOOK"
      ? await runAntigravityHook({ home, cwd, stdin })
      : command.kind === "CODEX_SHIM_INSTALL"
      ? await runCodexShimInstall({ home, cwd, launcherPath: fileURLToPath(new URL("./orchestra.mjs", import.meta.url)), nodePath: process.execPath })
        : await runRegistryCommand({ ...parsed, cwd, env });
    writeJson(stdout, result.payload);
    return result.exitCode;
  } catch (error) {
    writeJson(stderr, {
      ok: false,
      code: error?.code || "ORCHESTRA_V2_CLI_RUNTIME",
      message: error?.message || String(error),
    });
    return 2;
  }
}

const invoked = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (invoked) process.exitCode = await runGlobalCli();
