#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertParallelImplementationGroup } from "../../core/domain/parallel-implementation.mjs";
import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";
import { createCodexDelegationExecutor } from "../../providers/codex/delegation-executor.mjs";
import { assertCompositeArtifactId } from "./composite-artifact-store.mjs";
import {
  discardCompositeArtifact,
  inspectCompositeArtifact,
  promoteCompositeArtifact,
} from "./composite-artifact-control.mjs";
import { executeParallelImplementationGroup } from "./parallel-broker.mjs";

const USAGE_ERROR = "ORCHESTRA_PARALLEL_CLI_USAGE_INVALID";
const EXECUTION_ERROR = "ORCHESTRA_PARALLEL_CLI_EXECUTION_FAILED";
const RECURSION_ERROR = "ORCHESTRA_PARALLEL_CLI_RECURSION_DENIED";
const EXECUTE_FLAGS = Object.freeze([
  "--group-file",
  "--repo-root",
  "--source-provider",
  "--actor-id-hash",
]);
const INSPECT_FLAGS = Object.freeze(["--artifact", "--repo-root"]);
const MUTATION_FLAGS = Object.freeze([
  "--artifact",
  "--repo-root",
  "--generation",
  "--source-provider",
  "--actor-id-hash",
]);

function fail(stderr, code) {
  stderr.write(`${code}\n`);
  return 2;
}

function delegatedContext(env) {
  if (!env || typeof env !== "object") return false;
  if (env.ORCHESTRA_DELEGATION_ACTIVE === "1") return true;
  const depth = Number(env.ORCHESTRA_DELEGATION_DEPTH);
  return Number.isFinite(depth) && depth >= 1;
}

function boundedIdentity(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !value.startsWith("--");
}

function parsePairs(argv, expectedFlags) {
  if (!Array.isArray(argv) || argv.length !== expectedFlags.length * 2) return null;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!expectedFlags.includes(flag)
        || values.has(flag)
        || typeof value !== "string"
        || value.length === 0
        || value.startsWith("--")) return null;
    values.set(flag, value);
  }
  return values.size === expectedFlags.length ? values : null;
}

function parseArtifactId(value) {
  try {
    return assertCompositeArtifactId(value);
  } catch {
    return null;
  }
}

function rootActor(provider, actorIdHash) {
  if (!boundedIdentity(provider, 120) || !boundedIdentity(actorIdHash, 300)) return null;
  return {
    provider,
    actorIdHash,
    actorKind: "ROOT",
    isRoot: true,
  };
}

function readGroupFile(path) {
  try {
    const value = JSON.parse(readFileSync(resolve(path), "utf8"));
    assertParallelImplementationGroup(value);
    return value;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length < 1) return null;
  const [action, ...rest] = argv;

  if (action === "execute") {
    const values = parsePairs(rest, EXECUTE_FLAGS);
    if (!values) return null;
    const group = readGroupFile(values.get("--group-file"));
    const actor = rootActor(values.get("--source-provider"), values.get("--actor-id-hash"));
    if (!group || !actor
        || group.source.provider !== actor.provider
        || group.source.actorIdHash !== actor.actorIdHash) return null;
    return {
      action,
      repoRoot: resolve(values.get("--repo-root")),
      group,
      actor,
    };
  }

  if (action === "inspect") {
    const values = parsePairs(rest, INSPECT_FLAGS);
    if (!values) return null;
    const artifactId = parseArtifactId(values.get("--artifact"));
    if (!artifactId) return null;
    return {
      action,
      repoRoot: resolve(values.get("--repo-root")),
      artifactId,
    };
  }

  if (action !== "promote" && action !== "discard") return null;
  const values = parsePairs(rest, MUTATION_FLAGS);
  if (!values) return null;
  const artifactId = parseArtifactId(values.get("--artifact"));
  const generationText = values.get("--generation");
  const actor = rootActor(values.get("--source-provider"), values.get("--actor-id-hash"));
  if (!artifactId
      || !actor
      || !/^(0|[1-9][0-9]*)$/.test(generationText)) return null;
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation)) return null;
  return {
    action,
    repoRoot: resolve(values.get("--repo-root")),
    artifactId,
    generation,
    actor,
  };
}

function defaultExecutors() {
  return [
    createAntigravityDelegationExecutor(),
    createCodexDelegationExecutor(),
  ];
}

export async function runParallelCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  executors = null,
  executeGroup = executeParallelImplementationGroup,
  inspectArtifact = inspectCompositeArtifact,
  promoteArtifact = promoteCompositeArtifact,
  discardArtifact = discardCompositeArtifact,
} = {}) {
  if (delegatedContext(env)) return fail(stderr, RECURSION_ERROR);
  const args = parseArgs(argv);
  if (!args) return fail(stderr, USAGE_ERROR);

  try {
    let result;
    if (args.action === "execute") {
      result = await executeGroup({
        repoRoot: args.repoRoot,
        group: args.group,
        actor: args.actor,
        executors: executors ?? defaultExecutors(),
      });
    } else if (args.action === "inspect") {
      result = await inspectArtifact({
        repoRoot: args.repoRoot,
        artifactId: args.artifactId,
      });
    } else if (args.action === "promote") {
      result = await promoteArtifact({
        repoRoot: args.repoRoot,
        artifactId: args.artifactId,
        generation: args.generation,
        actor: args.actor,
      });
    } else {
      result = await discardArtifact({
        repoRoot: args.repoRoot,
        artifactId: args.artifactId,
        generation: args.generation,
        actor: args.actor,
      });
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    return fail(stderr, EXECUTION_ERROR);
  }
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
  process.exitCode = await runParallelCli();
}
