#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MINIMUM_NODE_MAJOR = 24;

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

export function evaluateV2RuntimeSupport(nodeVersion = process.versions.node) {
  const match = /^(\d+)\./.exec(String(nodeVersion));
  const major = match ? Number(match[1]) : Number.NaN;
  return Object.freeze({
    supported: Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR,
    currentVersion: String(nodeVersion),
    minimumMajor: MINIMUM_NODE_MAJOR,
  });
}

export async function runGlobalLauncher({
  nodeVersion = process.versions.node,
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  loadCli = () => import("./cli.mjs"),
} = {}) {
  const support = evaluateV2RuntimeSupport(nodeVersion);
  if (!support.supported) {
    writeJson(stderr, {
      ok: false,
      code: "ORCHESTRA_V2_RUNTIME_UNSUPPORTED",
      message: "Orchestra v2 requires Node.js 24 or newer",
      currentNode: support.currentVersion,
      minimumNodeMajor: support.minimumMajor,
    });
    return 2;
  }

  try {
    const { runGlobalCli } = await loadCli();
    return await runGlobalCli({ argv, cwd, env, stdout, stderr });
  } catch (error) {
    writeJson(stderr, {
      ok: false,
      code: error?.code || "ORCHESTRA_V2_BOOT_FAILED",
      message: error?.message || String(error),
    });
    return 2;
  }
}

const invoked = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) process.exitCode = await runGlobalLauncher();
