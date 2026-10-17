#!/usr/bin/env node

import {
  createGlobalProjectRegistry,
  globalRegistryStateExists,
  resolveOrchestraHome,
} from "./project-registry.mjs";
import { createGlobalOperationReconciler } from "./reconciliation.mjs";
import { createCodexHookHandler } from "../providers/codex/hook-handler.mjs";

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

  usage("Usage: orchestra <home|register|project status|project recover|project resolve-dirty|project rebind|provider codex hook> ...");
}

function notRegisteredResult() {
  return {
    exitCode: 1,
    payload: { ok: false, reason: "PROJECT_NOT_REGISTERED", registered: false },
  };
}

async function runRegistryCommand({ positionals, options, cwd, env }) {
  const home = explicitHome(options, env);
  const command = validateCommand({ positionals, options });

  if (command.kind === "HOME") {
    return { exitCode: 0, payload: { ok: true, home } };
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

async function readHookPayload(stdin) {
  let input = "";
  for await (const chunk of stdin) input += chunk.toString();
  if (!input.trim()) return { ok: false, reason: "CODEX_HOOK_PAYLOAD_INVALID" };
  try {
    const payload = JSON.parse(input);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, reason: "CODEX_HOOK_PAYLOAD_INVALID" };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "CODEX_HOOK_PAYLOAD_INVALID" };
  }
}

async function runCodexHook({ home, cwd, stdin }) {
  const decoded = await readHookPayload(stdin);
  if (!decoded.ok) return { exitCode: 1, payload: decoded };
  if (!(await globalRegistryStateExists({ home }))) {
    return { exitCode: 1, payload: { ok: false, reason: "PROJECT_NOT_REGISTERED", registered: false } };
  }
  const registry = createGlobalProjectRegistry({ home });
  try {
    const handler = createCodexHookHandler({ registry });
    const payload = await handler.handle(decoded.payload, { cwd });
    return { exitCode: payload.ok ? 0 : 1, payload };
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
    const result = command.kind === "CODEX_HOOK"
      ? await runCodexHook({ home: explicitHome(parsed.options, env), cwd, stdin })
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
