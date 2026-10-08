import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const MANIFEST = '.orchestra-core-manifest.json';
const TARGETS = Object.freeze([
  'runtimes/codex/.codex/astra-orchestra/core',
  'runtimes/antigravity/.agents/skills/orchestra/core',
]);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function walkFiles(root, prefix = '') {
  if (!existsSync(root)) return [];
  const result = [];
  for (const name of readdirSync(root).sort()) {
    const absolute = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(absolute).isDirectory()) result.push(...walkFiles(absolute, rel));
    else result.push(rel);
  }
  return result;
}

function expectedFiles(repoRoot) {
  const files = new Map();
  for (const rel of walkFiles(join(repoRoot, 'core'))) {
    files.set(rel, readFileSync(join(repoRoot, 'core', rel)));
  }
  for (const rel of walkFiles(join(repoRoot, 'schemas'))) {
    files.set(`schemas/${rel}`, readFileSync(join(repoRoot, 'schemas', rel)));
  }
  return files;
}

function manifestContent(files) {
  return `${JSON.stringify({
    schema: 'orchestra.runtime-core-manifest.v1',
    files: [...files.entries()].map(([path, content]) => ({ path, sha256: sha256(content) })),
  }, null, 2)}\n`;
}

function inspectTarget(repoRoot, targetRel, files, expectedManifest) {
  const target = join(repoRoot, targetRel);
  const missing = [];
  const stale = [];
  if (!existsSync(target)) {
    missing.push(targetRel);
    return { missing, stale };
  }

  for (const [rel, expected] of files) {
    const absolute = join(target, rel);
    if (!existsSync(absolute)) missing.push(`${targetRel}/${rel}`);
    else if (!readFileSync(absolute).equals(expected)) stale.push(`${targetRel}/${rel}`);
  }

  const manifestPath = join(target, MANIFEST);
  if (!existsSync(manifestPath)) missing.push(`${targetRel}/${MANIFEST}`);
  else if (readFileSync(manifestPath, 'utf8') !== expectedManifest) stale.push(`${targetRel}/${MANIFEST}`);

  const expectedPaths = new Set([...files.keys(), MANIFEST]);
  for (const rel of walkFiles(target)) {
    if (!expectedPaths.has(rel)) stale.push(`${targetRel}/${rel}`);
  }
  return { missing, stale };
}

export function syncRuntimeCore({ repoRoot = DEFAULT_ROOT, checkOnly = false } = {}) {
  const files = expectedFiles(repoRoot);
  const expectedManifest = manifestContent(files);
  const missing = [];
  const stale = [];
  const changed = [];

  for (const targetRel of TARGETS) {
    const inspection = inspectTarget(repoRoot, targetRel, files, expectedManifest);
    missing.push(...inspection.missing);
    stale.push(...inspection.stale);
    if (checkOnly) continue;

    const target = join(repoRoot, targetRel);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const [rel, content] of files) {
      const absolute = join(target, rel);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      changed.push(`${targetRel}/${rel}`);
    }
    writeFileSync(join(target, MANIFEST), expectedManifest);
    changed.push(`${targetRel}/${MANIFEST}`);
  }

  if (checkOnly && missing.length === 0 && stale.length === 0) {
    return { changed: [], stale: [], missing: [] };
  }
  return { changed, stale: [...new Set(stale)].sort(), missing: [...new Set(missing)].sort() };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  execFileSync(process.execPath, [join(DEFAULT_ROOT, 'scripts', 'build-schema-validators.mjs')], { stdio: 'inherit' });
  const result = syncRuntimeCore({ repoRoot: DEFAULT_ROOT });
  console.log(`Runtime core synchronized: ${result.changed.length} files written.`);
}
