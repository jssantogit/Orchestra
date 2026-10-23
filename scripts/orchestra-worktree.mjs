#!/usr/bin/env node
// Orchestra 1.5 temporary Codex worktree workflow.
// Runs only on operator request; no daemon, scheduler, global Home or V2 Work.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const manager = fileURLToPath(new URL("./orchestra-codex-project.mjs", import.meta.url));

function failure(code, message) {
  const error = new Error(message || code);
  error.code = code;
  throw error;
}

function parse(argv) {
  const command = argv.shift();
  if (!["create", "list", "doctor", "uninstall"].includes(command)) failure("WORKTREE_COMMAND_INVALID");
  const options = {};
  const allowed = new Set(["--repo", "--path", "--branch", "--from", "--dry-run"]);
  while (argv.length) {
    const key = argv.shift();
    if (!allowed.has(key) || Object.hasOwn(options, key)) failure("WORKTREE_OPTIONS_INVALID");
    if (key === "--dry-run") {
      options[key] = true;
      continue;
    }
    const value = argv.shift();
    if (!value || value.startsWith("--")) failure("WORKTREE_OPTIONS_INVALID");
    options[key] = value;
  }
  const required = command === "create" ? ["--repo", "--path", "--branch", "--from"]
    : command === "list" ? ["--repo"] : ["--path"];
  const permitted = command === "uninstall" ? [...required, "--dry-run"] : required;
  if (required.some((key) => !options[key])
    || Object.keys(options).some((key) => !permitted.includes(key))) {
    failure("WORKTREE_OPTIONS_INVALID");
  }
  return { command, options };
}

function child(binary, args, cwd) {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    failure("WORKTREE_CHILD_FAILED", binary + " returned " +
      (result.error?.code || result.status) + ": " + (result.stderr || "").trim().slice(0, 700));
  }
  return result.stdout.trim();
}

function git(repo, ...args) {
  return child("git", ["-C", repo, ...args], repo);
}

function repository(path) {
  const root = realpathSync(resolve(path));
  const top = realpathSync(git(root, "rev-parse", "--show-toplevel"));
  if (root !== top) failure("WORKTREE_REPOSITORY_ROOT_REQUIRED");
  return root;
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

function inspectRuntime(path) {
  const output = child(process.execPath, [manager, "doctor", path, "--json"], path);
  let doctor;
  try { doctor = JSON.parse(output); } catch { failure("WORKTREE_DOCTOR_PROTOCOL_INVALID"); }
  if (doctor.healthy !== true) failure("WORKTREE_DOCTOR_UNHEALTHY");
  return { healthy: true, status: doctor.status };
}

function create({ "--repo": source, "--path": location, "--branch": branch, "--from": revision }) {
  const repo = repository(source);
  const target = resolve(location);
  if (existsSync(target)) failure("WORKTREE_TARGET_EXISTS");
  if (within(repo, target)) failure("WORKTREE_TARGET_INSIDE_SOURCE");
  // Git validates branch/ref semantics and refuses to overwrite branches.
  git(repo, "check-ref-format", "--branch", branch);
  git(repo, "worktree", "add", "-b", branch, target, revision);

  // On install failure we deliberately preserve the worktree and its changes
  // for inspection. Never prune/reset it as an automatic failure handler.
  child(process.execPath, [manager, "install", target], target);
  const verified = inspectRuntime(target);
  return { ok: true, operation: "create", path: target, branch,
    head: git(target, "rev-parse", "HEAD"), ...verified };
}

function list({ "--repo": source }) {
  const repo = repository(source);
  const records = git(repo, "worktree", "list", "--porcelain")
    .split(/\r?\n\r?\n/).map((section) => section.split(/\r?\n/));
  const worktrees = records.filter((lines) => lines[0]?.startsWith("worktree "))
    .map((lines) => ({
      root: lines[0].slice("worktree ".length),
      head: lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? null,
      branch: lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null,
      locked: lines.some((line) => line.startsWith("locked")),
      prunable: lines.some((line) => line.startsWith("prunable")),
    }));
  return { ok: true, worktrees };
}

function doctor({ "--path": location }) {
  const target = repository(location);
  return { ok: true, path: target, ...inspectRuntime(target) };
}

// Temporary installation removal is intentionally separate from Git's
// worktree remove. Preserve the directory, branch, user data, backups, and
// sibling worktrees even when the Orchestra runtime is fully uninstalled.
function uninstall({ "--path": location, "--dry-run": dryRun = false }) {
  const target = repository(location);
  const args = [manager, "uninstall", target, "--json"];
  if (dryRun) args.push("--dry-run");
  const raw = child(process.execPath, args, target);
  let result;
  try { result = JSON.parse(raw); }
  catch { failure("WORKTREE_UNINSTALL_PROTOCOL_INVALID"); }
  if (typeof result.changed !== "boolean") failure("WORKTREE_UNINSTALL_PROTOCOL_INVALID");
  return {
    ok: true,
    operation: "uninstall",
    path: target,
    dryRun,
    changed: result.changed,
    statePreserved: true,
    codex: result.codex ?? null,
    delegation: result.delegation ?? null,
  };
}

function main() {
  try {
    const { command, options } = parse(process.argv.slice(2));
    const result = command === "create" ? create(options)
      : command === "list" ? list(options)
        : command === "doctor" ? doctor(options) : uninstall(options);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false, code: error?.code || "WORKTREE_RUNTIME_ERROR",
      message: String(error?.message || error).slice(0, 1000),
      preservation: "Existing worktrees, source code and runtime state were not automatically deleted.",
    }) + "\n");
    process.exitCode = 2;
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
