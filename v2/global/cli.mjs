#!/usr/bin/env node

import {
  createGlobalProjectRegistry,
  globalRegistryStateExists,
  resolveOrchestraHome,
} from "./project-registry.mjs";
import { createGlobalStatusReconciler } from "./reconciliation.mjs";

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
    if (!["home", "runtime-image", "instruction-epoch", "trust"].includes(name)) {
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

  if (command === "project" && positionals[1] === "rebind") {
    if (positionals.length !== 4) usage("Usage: orchestra project rebind <projectId> <newWorkspace>");
    return Object.freeze({
      kind: "PROJECT_REBIND",
      projectId: positionals[2],
      newRoot: positionals[3],
    });
  }

  usage("Usage: orchestra <home|register|project status|project rebind> ...");
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

  if (command.kind === "PROJECT_STATUS" && !(await globalRegistryStateExists({ home }))) {
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

      const reconciler = createGlobalStatusReconciler({
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

    const result = await registry.rebindWorkspace({
      projectId: command.projectId,
      newRoot: command.newRoot,
    });
    return { exitCode: result.ok ? 0 : 1, payload: result };
  } finally {
    registry.close();
  }
}

export async function runGlobalCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const parsed = parseArgs(argv);
    const result = await runRegistryCommand({ ...parsed, cwd, env });
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
