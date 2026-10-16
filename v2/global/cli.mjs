#!/usr/bin/env node

import { createGlobalProjectRegistry, resolveOrchestraHome } from "./project-registry.mjs";

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

async function runRegistryCommand({ positionals, options, cwd, env }) {
  const command = positionals[0];
  const home = explicitHome(options, env);

  if (command === "home") {
    if (positionals.length !== 1) usage("Usage: orchestra home [--home <path>]");
    return { exitCode: 0, payload: { ok: true, home } };
  }

  const registry = createGlobalProjectRegistry({ home });
  try {
    if (command === "register") {
      if (positionals.length > 2) {
        usage("Usage: orchestra register [workspace] --runtime-image <version> --instruction-epoch <n> --trust <mode>");
      }
      if (!options["runtime-image"]) usage("--runtime-image is required");
      if (!options.trust) usage("--trust is required");

      const result = await registry.registerWorkspace({
        root: positionals[1] || cwd,
        runtimeImage: options["runtime-image"],
        instructionEpoch: parseInstructionEpoch(options["instruction-epoch"]),
        trustMode: options.trust,
      });
      return { exitCode: result.ok ? 0 : 1, payload: result };
    }

    if (command === "project" && positionals[1] === "status") {
      if (positionals.length > 3) usage("Usage: orchestra project status [workspace|projectId]");
      const target = positionals[2] || cwd;
      const project = target.startsWith("prj_")
        ? registry.inspect(target)
        : await registry.resolveWorkspace(target);
      if (!project) {
        return {
          exitCode: 1,
          payload: { ok: false, reason: "PROJECT_NOT_REGISTERED", registered: false },
        };
      }
      return { exitCode: 0, payload: { ok: true, registered: true, project } };
    }

    if (command === "project" && positionals[1] === "rebind") {
      if (positionals.length !== 4) usage("Usage: orchestra project rebind <projectId> <newWorkspace>");
      const result = await registry.rebindWorkspace({
        projectId: positionals[2],
        newRoot: positionals[3],
      });
      return { exitCode: result.ok ? 0 : 1, payload: result };
    }

    usage("Usage: orchestra <home|register|project status|project rebind> ...");
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
