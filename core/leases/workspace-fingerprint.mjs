import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

function digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return createHash("sha256").update(bytes).digest("hex");
}

function gitOutput(root, args, { encoding = "utf8" } = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function nulPaths(buffer) {
  return String(buffer || "").split("\0").filter(Boolean);
}

function hashRegularFile(path) {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      h.update(buffer.subarray(0, bytesRead));
    }
    return h.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function workingFileIdentity(root, relPath) {
  const absolute = join(root, relPath);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return { path: relPath, kind: "SYMLINK", mode: stat.mode & 0o7777, contentHash: digest(readlinkSync(absolute, "utf8")) };
    }
    if (stat.isFile()) {
      return { path: relPath, kind: "FILE", mode: stat.mode & 0o7777, size: stat.size, contentHash: hashRegularFile(absolute) };
    }
    if (stat.isDirectory()) {
      let nestedHead = null;
      try { nestedHead = gitOutput(absolute, ["rev-parse", "HEAD"]).trim() || null; } catch {}
      return { path: relPath, kind: "DIRECTORY", mode: stat.mode & 0o7777, nestedHead };
    }
    return { path: relPath, kind: "OTHER", mode: stat.mode & 0o7777, size: stat.size };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: relPath, kind: "DELETED" };
    throw error;
  }
}

function pathspecs(excludedPaths = []) {
  return [".", ...excludedPaths.filter(Boolean).map((path) => `:(exclude)${path}`)];
}

export function readWorkspaceFingerprint(repoRoot, { excludedPaths = [] } = {}) {
  const root = resolve(repoRoot);
  try {
    const specs = pathspecs(excludedPaths);
    const head = gitOutput(root, ["rev-parse", "HEAD"]).trim() || null;
    const indexListing = gitOutput(root, ["ls-files", "-s", "-z", "--", ...specs], { encoding: "buffer" });
    const indexHash = digest(indexListing);
    const trackedDirty = nulPaths(gitOutput(root, ["diff", "--name-only", "-z", "HEAD", "--", ...specs], { encoding: "buffer" }));
    const untracked = nulPaths(gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...specs], { encoding: "buffer" }));
    const dirtyPaths = [...new Set([...trackedDirty, ...untracked])].sort();
    const workingFiles = dirtyPaths.map((relPath) => workingFileIdentity(root, relPath));
    const workingTreeHash = digest(workingFiles);
    return {
      available: true,
      head,
      indexHash,
      workingTreeHash,
      dirtyFileCount: workingFiles.length,
      fingerprint: digest({ head, indexHash, workingTreeHash }),
    };
  } catch {
    const fingerprint = digest({ git: "UNAVAILABLE" });
    return {
      available: false,
      head: null,
      indexHash: null,
      workingTreeHash: null,
      dirtyFileCount: null,
      fingerprint,
    };
  }
}
