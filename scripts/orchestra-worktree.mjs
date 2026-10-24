#!/usr/bin/env node
// Orchestra 1.5 temporary Codex worktree workflow.
// Runs only on operator request; no daemon, scheduler, global Home or V2 Work.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
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
  if (!["create", "create-clone", "list", "doctor", "uninstall"].includes(command)) failure("WORKTREE_COMMAND_INVALID");
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
  const required = ["create", "create-clone"].includes(command) ? ["--repo", "--path", "--branch", "--from"]
    : command === "list" ? ["--repo"] : ["--path"];
  const permitted = command === "uninstall" ? [...required, "--dry-run"] : required;
  if (required.some((key) => !options[key])
    || Object.keys(options).some((key) => !permitted.includes(key))) {
    failure("WORKTREE_OPTIONS_INVALID");
  }
  return { command, options };
}

function child(binary, args, cwd, { timeoutMs = 90_000 } = {}) {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error?.code === "ETIMEDOUT" && binary === "git" && args[0] === "clone") {
    failure("WORKTREE_CLONE_TIMEOUT_PRESERVED",
      "Independent clone exceeded its time budget; Git pack/index-pack children may still be running. Inspect running processes and repository integrity before reusing the preserved directory. Never delete or retry blindly.");
  }
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
  // Git answers this relative to its *actual* worktree root, so no lexical
  // comparison of differently cased/separated Windows absolute paths.
  if (git(root, "rev-parse", "--show-prefix") !== "") {
    failure("WORKTREE_REPOSITORY_ROOT_REQUIRED");
  }
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
  return { healthy: true, status: doctor.status, hookActivation: doctor.hookActivation };
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

// Codex 0.159/0.164 intentionally discovers project hooks in the primary
// checkout of a linked worktree. This explicit alternative creates a separate
// Git repository so its project hooks belong to its own checkout. No hooks or
// trust settings are copied to the caller's main checkout or global Codex home.
// Do NOT assume native hook discovery/approval: the operator must review /hooks.
function createClone({ "--repo": source, "--path": location, "--branch": branch, "--from": revision }) {
  const repo = repository(source);
  const target = resolve(location);
  if (existsSync(target)) failure("WORKTREE_TARGET_EXISTS");
  if (within(repo, target)) failure("WORKTREE_TARGET_INSIDE_SOURCE");
  git(repo, "check-ref-format", "--branch", branch);
  const commit = git(repo, "rev-parse", "--verify", `${revision}^{commit}`);
  // --no-local uses Git transport, never Git object hardlinks or alternates.
  // Do not change the source repository, main checkout, or its branches.
  // Large Android repositories may need longer than the regular 90s CLI
  // budget for pack/index-pack. This does not authorize an automatic retry.
  child("git", ["clone", "--no-local", "--no-checkout", "--quiet", repo, target], repo,
    { timeoutMs: 10 * 60_000 });
  // As in create(), failures preserve the clone for operator inspection.
  git(target, "checkout", "-q", "-b", branch, commit);
  child(process.execPath, [manager, "install", target], target);
  const verified = inspectRuntime(target);
  return { ok: true, operation: "create-clone", checkoutType: "INDEPENDENT_CLONE",
    nativeHookDiscovery: "REQUIRES_NATIVE_VERIFICATION", path: target, branch,
    head: git(target, "rev-parse", "HEAD"), ...verified };
}

function list({ "--repo": source }) {
  const repo = repository(source);
  const records = git(repo, "worktree", "list", "--porcelain")
    .split(/\r?\n\r?\n/).map((section) => section.split(/\r?\n/));
  const worktrees = records.filter((lines) => lines[0]?.startsWith("worktree "))
    .map((lines) => ({
      root: existsSync(lines[0].slice("worktree ".length))
        ? realpathSync(lines[0].slice("worktree ".length))
        : resolve(lines[0].slice("worktree ".length)),
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
  // The convenience lifecycle command must never target the canonical checkout.
  // Git's common directory is shared by every linked worktree. A separate
  // non-worktree root must use the explicit generic runtime uninstall CLI.
  // A linked Git worktree uses a .git *file*, pointing to the main repo's
  // .git/worktrees/<name> private Git directory. The primary checkout uses a
  // .git directory. This check avoids Windows drive spelling/casing aliases.
  let dotgit;
  try { dotgit = lstatSync(resolve(target, ".git")); }
  catch { failure("WORKTREE_LINKED_ONLY"); }
  if (!dotgit.isFile()) failure("WORKTREE_LINKED_ONLY");
  const gitDir = git(target, "rev-parse", "--absolute-git-dir");
  if (!gitDir.split(/[\\/]/).includes("worktrees")) failure("WORKTREE_LINKED_ONLY");

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
      : command === "create-clone" ? createClone(options)
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
