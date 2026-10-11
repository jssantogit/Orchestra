import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSchemaValidators } from "./build-schema-validators.mjs";

export const RUNTIME_CORE_MIRRORS = Object.freeze([
  "runtimes/codex/.codex/astra-orchestra/core",
  "runtimes/antigravity/.agents/skills/orchestra/core",
]);

export const RUNTIME_PROVIDER_MIRRORS = Object.freeze([
  Object.freeze({
    provider: "codex",
    sourceRoot: "providers/codex",
    mirrorRoot: "runtimes/codex/.codex/astra-orchestra/provider/codex",
  }),
  Object.freeze({
    provider: "antigravity",
    sourceRoot: "providers/antigravity",
    mirrorRoot: "runtimes/antigravity/.agents/skills/orchestra/provider/antigravity",
  }),
]);

const CORE_MANIFEST_FILE = "runtime-core-manifest.json";
const CORE_MANIFEST_SCHEMA = "orchestra.runtime-core-manifest.v1";
const PROVIDER_MANIFEST_FILE = "runtime-provider-manifest.json";
const PROVIDER_MANIFEST_SCHEMA = "orchestra.runtime-provider-manifest.v1";

function posix(path) {
  return path.split(sep).join("/");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function walkFiles(root) {
  const files = [];
  async function visit(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

function appendManifest(payload, { file, schema, provider = undefined }) {
  const files = [...payload.entries()]
    .map(([path, bytes]) => ({ path, sha256: digest(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const record = provider ? { schema, provider, files } : { schema, files };
  payload.set(file, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"));
  return payload;
}

async function canonicalCorePayload(repoRoot) {
  const sources = [
    { root: join(repoRoot, "core"), prefix: "" },
    { root: join(repoRoot, "schemas"), prefix: "schemas" },
  ];
  const payload = new Map();

  for (const source of sources) {
    for (const absolute of await walkFiles(source.root)) {
      const rel = posix(relative(source.root, absolute));
      const target = source.prefix ? `${source.prefix}/${rel}` : rel;
      payload.set(target, await readFile(absolute));
    }
  }

  return appendManifest(payload, {
    file: CORE_MANIFEST_FILE,
    schema: CORE_MANIFEST_SCHEMA,
  });
}

async function canonicalProviderPayload(repoRoot, config) {
  const absoluteRoot = join(repoRoot, config.sourceRoot);
  const payload = new Map();
  for (const absolute of await walkFiles(absoluteRoot)) {
    const rel = posix(relative(absoluteRoot, absolute));
    payload.set(rel, await readFile(absolute));
  }
  return appendManifest(payload, {
    file: PROVIDER_MANIFEST_FILE,
    schema: PROVIDER_MANIFEST_SCHEMA,
    provider: config.provider,
  });
}

async function inspectMirror(repoRoot, mirrorRoot, payload) {
  const absoluteRoot = join(repoRoot, mirrorRoot);
  const actualFiles = await walkFiles(absoluteRoot);
  const actual = new Map(actualFiles.map((absolute) => [posix(relative(absoluteRoot, absolute)), absolute]));
  const missing = [];
  const stale = [];
  const changed = [];

  for (const [rel, expected] of payload) {
    const absolute = actual.get(rel);
    const reported = `${mirrorRoot}/${rel}`;
    if (!absolute) {
      missing.push(reported);
      continue;
    }
    const current = await readFile(absolute);
    if (!current.equals(expected)) stale.push(reported);
    actual.delete(rel);
  }

  for (const rel of actual.keys()) changed.push(`${mirrorRoot}/${rel}`);
  return {
    changed: changed.sort(),
    stale: stale.sort(),
    missing: missing.sort(),
  };
}

async function writeMirror(repoRoot, mirrorRoot, payload) {
  const absoluteRoot = join(repoRoot, mirrorRoot);
  await rm(absoluteRoot, { recursive: true, force: true });
  for (const [rel, bytes] of payload) {
    const absolute = join(absoluteRoot, rel);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
}

async function reconcileMirror({ root, mirrorRoot, payload, checkOnly, result }) {
  const mirror = await inspectMirror(root, mirrorRoot, payload);
  result.changed.push(...mirror.changed);
  result.stale.push(...mirror.stale);
  result.missing.push(...mirror.missing);
  if (!checkOnly && (mirror.changed.length || mirror.stale.length || mirror.missing.length)) {
    await writeMirror(root, mirrorRoot, payload);
  }
}

export async function syncRuntimeCore({ repoRoot, checkOnly = false }) {
  if (!repoRoot) throw new TypeError("repoRoot is required");
  const root = resolve(repoRoot);
  const schemaResult = await buildSchemaValidators({ checkOnly: true, repoRoot: root });
  if (schemaResult.changed.length || schemaResult.missing.length) {
    const drift = [...schemaResult.missing, ...schemaResult.changed];
    const error = new Error(`Canonical schema validator drift: ${drift.join(", ")}`);
    error.code = "SCHEMA_VALIDATOR_DRIFT";
    error.schemaResult = schemaResult;
    throw error;
  }

  const result = { changed: [], stale: [], missing: [] };
  const corePayload = await canonicalCorePayload(root);
  for (const mirrorRoot of RUNTIME_CORE_MIRRORS) {
    await reconcileMirror({ root, mirrorRoot, payload: corePayload, checkOnly, result });
  }

  for (const config of RUNTIME_PROVIDER_MIRRORS) {
    const providerPayload = await canonicalProviderPayload(root, config);
    await reconcileMirror({
      root,
      mirrorRoot: config.mirrorRoot,
      payload: providerPayload,
      checkOnly,
      result,
    });
  }

  result.changed.sort();
  result.stale.sort();
  result.missing.sort();
  return result;
}

function hasDrift(result) {
  return result.changed.length > 0 || result.stale.length > 0 || result.missing.length > 0;
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const result = await syncRuntimeCore({ repoRoot });
  if (hasDrift(result)) {
    console.log(`Runtime generated mirrors synchronized: ${result.missing.length} missing, ${result.stale.length} stale, ${result.changed.length} unexpected repaired.`);
  } else {
    console.log("Runtime generated mirrors: already current.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
