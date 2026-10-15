#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  discardDelegationArtifact,
  inspectDelegationArtifact,
  promoteDelegationArtifact,
} from "./artifact-lifecycle.mjs";
import { assertArtifactId } from "./artifact-store.mjs";

const USAGE_ERROR = "ORCHESTRA_DELEGATION_ARTIFACT_CLI_USAGE_INVALID";
const EXECUTION_ERROR = "ORCHESTRA_DELEGATION_ARTIFACT_CLI_EXECUTION_FAILED";
const RECURSION_ERROR = "ORCHESTRA_DELEGATION_ARTIFACT_CLI_RECURSION_DENIED";
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
    return assertArtifactId(value);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length < 1) return null;
  const [action, ...rest] = argv;
  if (action === "inspect") {
    const values = parsePairs(rest, INSPECT_FLAGS);
    if (!values) return null;
    const artifactId = parseArtifactId(values.get("--artifact"));
    if (!artifactId) return null;
    return {
      action,
      artifactId,
      repoRoot: resolve(values.get("--repo-root")),
    };
  }

  if (action !== "promote" && action !== "discard") return null;
  const values = parsePairs(rest, MUTATION_FLAGS);
  if (!values) return null;
  const artifactId = parseArtifactId(values.get("--artifact"));
  const generationText = values.get("--generation");
  const sourceProvider = values.get("--source-provider");
  const actorIdHash = values.get("--actor-id-hash");
  if (!artifactId
      || !/^(0|[1-9][0-9]*)$/.test(generationText)
      || !boundedIdentity(sourceProvider, 120)
      || !boundedIdentity(actorIdHash, 300)) return null;
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation)) return null;

  return {
    action,
    artifactId,
    repoRoot: resolve(values.get("--repo-root")),
    generation,
    actor: {
      provider: sourceProvider,
      actorIdHash,
      actorKind: "ROOT",
      isRoot: true,
    },
  };
}

export async function runArtifactCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  inspectArtifact = inspectDelegationArtifact,
  promoteArtifact = promoteDelegationArtifact,
  discardArtifact = discardDelegationArtifact,
} = {}) {
  if (delegatedContext(env)) return fail(stderr, RECURSION_ERROR);

  const args = parseArgs(argv);
  if (!args) return fail(stderr, USAGE_ERROR);

  try {
    let result;
    if (args.action === "inspect") {
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
  process.exitCode = await runArtifactCli();
}
