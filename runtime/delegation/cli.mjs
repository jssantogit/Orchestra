#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertDelegationRequest,
  assertDelegationResult,
} from "../../core/domain/delegation.mjs";
import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";
import { createDelegationBroker } from "./broker.mjs";

const USAGE_ERROR = "ORCHESTRA_DELEGATION_CLI_USAGE_INVALID";
const REQUEST_ERROR = "ORCHESTRA_DELEGATION_CLI_REQUEST_INVALID";
const TARGET_ERROR = "ORCHESTRA_DELEGATION_CLI_TARGET_UNAVAILABLE";
const EXECUTION_ERROR = "ORCHESTRA_DELEGATION_CLI_EXECUTION_FAILED";
const EXPECTED_FLAGS = Object.freeze(["--request", "--repo-root", "--generation"]);

function fail(stderr, code) {
  stderr.write(`${code}\n`);
  return 2;
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== EXPECTED_FLAGS.length * 2) return null;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!EXPECTED_FLAGS.includes(name)
        || values.has(name)
        || typeof value !== "string"
        || value.length === 0
        || value.startsWith("--")) return null;
    values.set(name, value);
  }
  if (values.size !== EXPECTED_FLAGS.length) return null;

  const generationText = values.get("--generation");
  if (!/^(0|[1-9][0-9]*)$/.test(generationText)) return null;
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation)) return null;

  return {
    requestPath: resolve(values.get("--request")),
    repoRoot: resolve(values.get("--repo-root")),
    generation,
  };
}

function readCanonicalRequest(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
    assertDelegationRequest(parsed);
  } catch {
    return null;
  }
  return parsed;
}

function rootActorFor(request) {
  return {
    provider: request.source.provider,
    actorIdHash: request.source.actorIdHash,
    actorKind: "ROOT",
    isRoot: true,
  };
}

export async function runDelegationCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  createExecutor = createAntigravityDelegationExecutor,
  createBroker = createDelegationBroker,
} = {}) {
  const args = parseArgs(argv);
  if (!args) return fail(stderr, USAGE_ERROR);

  const request = readCanonicalRequest(args.requestPath);
  if (!request) return fail(stderr, REQUEST_ERROR);

  let executor;
  try {
    executor = createExecutor();
  } catch {
    return fail(stderr, TARGET_ERROR);
  }
  if (!executor
      || typeof executor !== "object"
      || executor.provider !== request.target.provider) {
    return fail(stderr, TARGET_ERROR);
  }

  let broker;
  try {
    broker = createBroker({ executors: [executor] });
  } catch {
    return fail(stderr, EXECUTION_ERROR);
  }
  if (!broker || typeof broker.executeDelegation !== "function") {
    return fail(stderr, EXECUTION_ERROR);
  }

  let result;
  try {
    result = await broker.executeDelegation(request, {
      repoRoot: args.repoRoot,
      generation: args.generation,
      actor: rootActorFor(request),
    });
    assertDelegationResult(result);
  } catch {
    return fail(stderr, EXECUTION_ERROR);
  }

  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runDelegationCli();
}
