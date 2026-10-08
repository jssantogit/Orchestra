import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_CORE_MIRRORS = Object.freeze([
  "runtimes/codex/.codex/astra-orchestra/core",
  "runtimes/antigravity/.agents/skills/orchestra/core",
]);

const MANIFEST_FILE = "runtime-core-manifest.json";
const MANIFEST_SCHEMA = "orchestra.runtime-core-manifest.v1";

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

async function canonicalPayload(repoRoot) {
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

  const files = [...payload.entries()]
    .map(([path, bytes]) => ({ path, sha256: digest(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest = Buffer.from(`${JSON.stringify({ schema: MANIFEST_SCHEMA, files }, null, 2)}\n`, "utf8");
  payload.set(MANIFEST_FILE, manifest);
  return payload;
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

export async function syncRuntimeCore({ repoRoot, checkOnly = false }) {
  if (!repoRoot) throw new TypeError("repoRoot is required");
  const root = resolve(repoRoot);
  const payload = await canonicalPayload(root);
  const result = { changed: [], stale: [], missing: [] };

  for (const mirrorRoot of RUNTIME_CORE_MIRRORS) {
    const mirror = await inspectMirror(root, mirrorRoot, payload);
    result.changed.push(...mirror.changed);
    result.stale.push(...mirror.stale);
    result.missing.push(...mirror.missing);
    if (!checkOnly && (mirror.changed.length || mirror.stale.length || mirror.missing.length)) {
      await writeMirror(root, mirrorRoot, payload);
    }
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
    console.log(`Runtime core mirror synchronized: ${result.missing.length} missing, ${result.stale.length} stale, ${result.changed.length} unexpected repaired.`);
  } else {
    console.log("Runtime core mirror: already current.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
