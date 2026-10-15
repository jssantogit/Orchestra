import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_NO_HOOKS_PREFIX = Object.freeze(["-c", "core.hooksPath="]);

export async function runDelegationGit(cwd, args, {
  env = process.env,
  timeoutMs = 15_000,
  maxBuffer = 16 * 1024 * 1024,
} = {}) {
  return execFileAsync("git", [...GIT_NO_HOOKS_PREFIX, ...args], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer,
  });
}

export async function readDelegationGitStdout(cwd, args, options = {}) {
  const result = await runDelegationGit(cwd, args, options);
  return String(result.stdout ?? "");
}

async function appendHooksFingerprint(hash, hooksRoot, relRoot = "") {
  let entries;
  try {
    entries = await readdir(hooksRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      hash.update("hooks:none\0");
      return;
    }
    throw error;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relPath = relRoot ? `${relRoot}/${entry.name}` : entry.name;
    const absolute = join(hooksRoot, entry.name);
    const stat = await lstat(absolute);
    hash
      .update("path\0")
      .update(relPath)
      .update("\0mode\0")
      .update(String(stat.mode & 0o7777))
      .update("\0");

    if (stat.isSymbolicLink()) {
      hash.update("symlink\0").update(await readlink(absolute)).update("\0");
    } else if (stat.isDirectory()) {
      hash.update("dir\0");
      await appendHooksFingerprint(hash, absolute, relPath);
    } else if (stat.isFile()) {
      hash.update("file\0").update(await readFile(absolute)).update("\0");
    } else {
      hash.update("other\0");
    }
  }
}

async function readHooksFingerprint(repoRoot, options = {}) {
  const commonDirText = (await readDelegationGitStdout(repoRoot, ["rev-parse", "--git-common-dir"], options)).trim();
  if (!commonDirText) throw new Error("GIT_COMMON_DIR_UNAVAILABLE");
  const commonDir = isAbsolute(commonDirText)
    ? resolve(commonDirText)
    : resolve(repoRoot, commonDirText);
  const hash = createHash("sha256").update("orchestra.delegation.git-hooks.v1\0");
  await appendHooksFingerprint(hash, join(commonDir, "hooks"));
  return hash.digest("hex");
}

export async function readDelegationGitBoundary(repoRoot, options = {}) {
  try {
    const [refs, config, hooks] = await Promise.all([
      readDelegationGitStdout(repoRoot, ["show-ref", "--head"], options),
      readDelegationGitStdout(repoRoot, ["config", "--local", "--null", "--list"], options),
      readHooksFingerprint(repoRoot, options),
    ]);
    const fingerprint = createHash("sha256")
      .update("orchestra.delegation.git-boundary.v2\0")
      .update(refs)
      .update("\0config\0")
      .update(config)
      .update("\0hooks\0")
      .update(hooks)
      .digest("hex");
    return { available: true, fingerprint };
  } catch {
    return { available: false, fingerprint: null };
  }
}
