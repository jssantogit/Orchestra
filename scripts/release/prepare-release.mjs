#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bumpVersion, parseStableVersion, selectLatestStableTag, suggestBump } from "./versioning.mjs";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIMES = Object.freeze(["core", "codex", "antigravity"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function tagVersion(tag) {
  const match = /^v(.+)$/.exec(String(tag || ""));
  if (!match) throw new Error(`Expected release tag in vX.Y.Z form, got: ${tag}`);
  parseStableVersion(match[1]);
  return match[1];
}

function categoryFor(subject) {
  if (/^feat(?:\([^)]*\))?!?:/.test(subject)) return "features";
  if (/^(?:fix|perf)(?:\([^)]*\))?!?:/.test(subject)) return "fixes";
  return "other";
}

function renderItems(commits) {
  return commits.map((commit) => `- ${commit.subject} (\`${String(commit.sha || "").slice(0, 8)}\`)`).join("\n");
}

function renderNotes({ version, baseTag, bump, suggestedBump, commits, generatedAt }) {
  const groups = { features: [], fixes: [], other: [] };
  for (const commit of commits) groups[categoryFor(String(commit.subject || ""))].push(commit);
  const sections = [];
  if (groups.features.length) sections.push(`## Features\n\n${renderItems(groups.features)}`);
  if (groups.fixes.length) sections.push(`## Fixes\n\n${renderItems(groups.fixes)}`);
  if (groups.other.length) sections.push(`## Other changes\n\n${renderItems(groups.other)}`);
  if (!sections.length) sections.push("## Changes\n\n- No conventional release notes were inferred; review the commit range before merging.");

  return [
    `# Orchestra v${version}`,
    "",
    "Prepared by the Orchestra Release Train for operator review.",
    "",
    `- Base tag: \`${baseTag}\``,
    `- Requested bump: \`${bump}\``,
    `- Suggested bump: \`${suggestedBump || "none"}\``,
    `- Generated at: \`${generatedAt}\``,
    "",
    ...sections.flatMap((section) => [section, ""]),
    "## Publication gate",
    "",
    "Merging the corresponding `release/vX.Y.Z` pull request with GitHub's **Create a merge commit** option is the operator authorization to publish. Publication occurs only after the exact two-parent `main` merge SHA produced by that merge completes the canonical `CI` workflow successfully.",
    "",
    "Squash and rebase merges fail closed. The publisher creates an annotated tag and GitHub Release idempotently. If the tag already exists, it must point at the exact authorized release integration SHA; a conflicting tag fails closed.",
    "",
  ].join("\n");
}

export function prepareRelease({ repoRoot = moduleRoot, bump, baseTag, commits = [], generatedAt = new Date().toISOString() }) {
  const root = resolve(repoRoot);
  const pkgPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const pkg = readJson(pkgPath);
  const lock = readJson(lockPath);
  const currentVersion = String(pkg.version || "");
  parseStableVersion(currentVersion);
  const baseVersion = tagVersion(baseTag);
  if (baseVersion !== currentVersion) {
    throw new Error(`Base tag ${baseTag} does not match package version ${currentVersion}`);
  }

  const version = bumpVersion(currentVersion, bump);
  const tag = `v${version}`;
  const suggestedBump = suggestBump(commits);

  pkg.version = version;
  if (!pkg.scripts || typeof pkg.scripts !== "object") pkg.scripts = {};
  pkg.scripts["release:readiness"] = "node scripts/release-readiness.mjs";
  lock.version = version;
  if (!lock.packages?.[""]) throw new Error("package-lock.json is missing packages[''] metadata");
  lock.packages[""].version = version;

  writeJson(pkgPath, pkg);
  writeJson(lockPath, lock);
  for (const runtime of RUNTIMES) {
    const manifestPath = join(root, "runtime", "manifests", `${runtime}.json`);
    const manifest = readJson(manifestPath);
    manifest.version = version;
    writeJson(manifestPath, manifest);
  }

  const notesPath = join(root, "docs", "release", `${tag}.md`);
  writeFileSync(notesPath, renderNotes({ version, baseTag, bump, suggestedBump, commits, generatedAt }));
  return { currentVersion, version, tag, baseTag, bump, suggestedBump, notesPath };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function latestReleaseTag(repoRoot = moduleRoot) {
  const root = resolve(repoRoot);
  const tags = git(root, ["tag", "--merged", "HEAD", "--list", "v*"])
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return selectLatestStableTag(tags);
}

export function commitsSince(repoRoot, baseTag) {
  const output = git(resolve(repoRoot), ["log", `${baseTag}..HEAD`, "--format=%H%x1f%s%x1f%b%x1e"]);
  if (!output) return [];
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split("\x1f");
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
    });
}

function argValue(argv, name) {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function appendGithubOutput(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = [
    `version=${result.version}`,
    `tag=${result.tag}`,
    `base_tag=${result.baseTag}`,
    `requested_bump=${result.bump}`,
    `suggested_bump=${result.suggestedBump || "none"}`,
    `branch=release/${result.tag}`,
    `notes_path=docs/release/${result.tag}.md`,
  ];
  writeFileSync(outputPath, `${lines.join("\n")}\n`, { flag: "a" });
}

function main() {
  const argv = process.argv.slice(2);
  const bump = argValue(argv, "--bump");
  const repoRoot = resolve(argValue(argv, "--repo-root") || moduleRoot);
  if (!bump) throw new Error("Missing required --bump=patch|minor|major");
  const baseTag = latestReleaseTag(repoRoot);
  const commits = commitsSince(repoRoot, baseTag);
  const result = prepareRelease({ repoRoot, bump, baseTag, commits });
  appendGithubOutput(result);
  console.log(JSON.stringify({ ...result, notesPath: `docs/release/${result.tag}.md` }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
