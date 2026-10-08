#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSchemaValidators } from "./build-schema-validators.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, "..");

export const RUNTIME_CORE_MIRRORS = Object.freeze([
  "runtimes/codex/.codex/astra-orchestra/core",
  "runtimes/antigravity/.agents/skills/orchestra/core",
]);

function posix(path) {
  return path.split(sep).join("/");
}

function repoRelative(repoRoot, path) {
  return posix(relative(repoRoot, path));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root, prefix = "") {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(root, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, relativePath));
    else if (entry.isFile()) files.push({ absolute, relativePath });
  }
  return files;
}

async function expectedRuntimeCore(repoRoot) {
  await buildSchemaValidators({ repoRoot });

  const expected = new Map();
  for (const file of await collectFiles(join(repoRoot, "core"))) {
    expected.set(file.relativePath, await readFile(file.absolute));
  }
  for (const file of await collectFiles(join(repoRoot, "schemas"))) {
    expected.set(`schemas/${file.relativePath}`, await readFile(file.absolute));
  }

  const manifest = {
    schema: "orchestra.runtime-core-manifest.v1",
    files: [...expected.keys()].sort().map((path) => ({ path })),
  };
  expected.set("runtime-core-manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  return expected;
}

async function inspectMirror(repoRoot, mirrorRelative, expected) {
  const mirrorRoot = join(repoRoot, mirrorRelative);
  const actualFiles = await collectFiles(mirrorRoot);
  const actualPaths = new Set(actualFiles.map((file) => file.relativePath));
  const missing = [];
  const stale = [];

  for (const [relativePath, expectedContent] of expected.entries()) {
    const absolute = join(mirrorRoot, relativePath);
    if (!actualPaths.has(relativePath)) {
      missing.push(repoRelative(repoRoot, absolute));
      continue;
    }
    const actualContent = await readFile(absolute);
    if (!actualContent.equals(expectedContent)) stale.push(repoRelative(repoRoot, absolute));
  }

  for (const file of actualFiles) {
    if (!expected.has(file.relativePath)) stale.push(repoRelative(repoRoot, file.absolute));
  }

  return { missing: missing.sort(), stale: [...new Set(stale)].sort() };
}

async function writeMirror(repoRoot, mirrorRelative, expected) {
  const mirrorRoot = join(repoRoot, mirrorRelative);
  await rm(mirrorRoot, { recursive: true, force: true });
  const changed = [];
  for (const [relativePath, content] of expected.entries()) {
    const absolute = join(mirrorRoot, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    changed.push(repoRelative(repoRoot, absolute));
  }
  return changed.sort();
}

export async function syncRuntimeCore({ repoRoot = defaultRepoRoot, checkOnly = false } = {}) {
  const expected = await expectedRuntimeCore(repoRoot);
  const missing = [];
  const stale = [];
  const changed = [];

  for (const mirrorRelative of RUNTIME_CORE_MIRRORS) {
    const inspection = await inspectMirror(repoRoot, mirrorRelative, expected);
    missing.push(...inspection.missing);
    stale.push(...inspection.stale);
    if (!checkOnly && (inspection.missing.length || inspection.stale.length)) {
      changed.push(...await writeMirror(repoRoot, mirrorRelative, expected));
    }
  }

  return {
    changed: changed.sort(),
    stale: [...new Set(stale)].sort(),
    missing: [...new Set(missing)].sort(),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await syncRuntimeCore();
  console.log(`Runtime core mirrors synced: changed=${result.changed.length} repaired_stale=${result.stale.length} repaired_missing=${result.missing.length}`);
}
