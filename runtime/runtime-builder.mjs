import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRuntimeManifest } from "./manifest-loader.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_METADATA = "orchestra-runtime-build.json";

function normalizeRelative(value) {
  return value.split(sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function isExcluded(path, patterns = []) {
  const normalized = normalizeRelative(path);
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const base = pattern.slice(0, -3).replace(/\/$/, "");
      return normalized === base || normalized.startsWith(`${base}/`);
    }
    return normalized === pattern;
  });
}

async function ensureParent(path) {
  await mkdir(dirname(path), { recursive: true });
}

async function copyNode({ source, destination, rootSource, exclude = [] }) {
  const stat = await lstat(source);
  const relativeSource = normalizeRelative(relative(rootSource, source));
  if (relativeSource && isExcluded(relativeSource, exclude)) return;

  if (stat.isSymbolicLink()) {
    await ensureParent(destination);
    await rm(destination, { recursive: true, force: true });
    await symlink(await readlink(source), destination);
    return;
  }

  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      await copyNode({
        source: join(source, entry.name),
        destination: join(destination, entry.name),
        rootSource,
        exclude,
      });
    }
    return;
  }

  if (!stat.isFile()) {
    throw new Error(`Unsupported runtime asset type at ${source}`);
  }

  await ensureParent(destination);
  await rm(destination, { recursive: true, force: true });
  await writeFile(destination, await readFile(source));
  await chmod(destination, stat.mode & 0o777);
}

async function copyManagedAsset(asset, outputDir) {
  const source = resolve(repoRoot, asset.source);
  const destination = resolve(outputDir, asset.output);
  const stat = await lstat(source);

  if (asset.type === "file" && !stat.isFile()) {
    throw new Error(`Runtime asset ${asset.source} is not a file`);
  }
  if (asset.type === "tree" && !stat.isDirectory()) {
    throw new Error(`Runtime asset ${asset.source} is not a directory tree`);
  }
  if (asset.type === "symlink" && !stat.isSymbolicLink()) {
    throw new Error(`Runtime asset ${asset.source} is not a symlink`);
  }

  await copyNode({
    source,
    destination,
    rootSource: source,
    exclude: asset.exclude || [],
  });
}

async function listBuildFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = [];

  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const path = normalizeRelative(relative(root, absolute));
    if (path === BUILD_METADATA) continue;
    const stat = await lstat(absolute);

    if (stat.isDirectory()) {
      files.push(...await listBuildFiles(root, absolute));
      continue;
    }

    if (stat.isSymbolicLink()) {
      files.push({
        path,
        sha256: sha256(`symlink:${await readlink(absolute)}`),
        mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
        type: "symlink",
      });
      continue;
    }

    if (stat.isFile()) {
      files.push({
        path,
        sha256: sha256(await readFile(absolute)),
        mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
        type: "file",
      });
      continue;
    }

    throw new Error(`Unsupported built runtime entry at ${absolute}`);
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function buildRuntime({ runtime, outputDir }) {
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    throw new Error("outputDir must be a non-empty path");
  }

  const manifest = await loadRuntimeManifest(runtime);
  const absoluteOutput = resolve(outputDir);
  await rm(absoluteOutput, { recursive: true, force: true });
  await mkdir(absoluteOutput, { recursive: true });

  for (const asset of manifest.managedAssets) {
    await copyManagedAsset(asset, absoluteOutput);
  }

  const files = await listBuildFiles(absoluteOutput);
  const metadata = {
    runtime: manifest.runtime,
    manifestHash: sha256(stableJson(manifest)),
    files,
    version: manifest.version,
  };
  await writeFile(join(absoluteOutput, BUILD_METADATA), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export async function verifyBuiltRuntime({ runtime, outputDir }) {
  const manifest = await loadRuntimeManifest(runtime);
  const absoluteOutput = resolve(outputDir);
  const metadata = JSON.parse(await readFile(join(absoluteOutput, BUILD_METADATA), "utf8"));
  const actualFiles = await listBuildFiles(absoluteOutput);
  const expected = {
    runtime: manifest.runtime,
    manifestHash: sha256(stableJson(manifest)),
    files: actualFiles,
    version: manifest.version,
  };
  if (JSON.stringify(metadata) !== JSON.stringify(expected)) {
    throw new Error(`Built runtime ${runtime} does not match its deterministic metadata`);
  }
  return metadata;
}

export function runtimeRepositoryRoot() {
  return repoRoot;
}
