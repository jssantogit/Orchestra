import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const START = "# >>> orchestra managed state >>>";
const END = "# <<< orchestra managed state <<<";
const MANAGED_PATTERNS = Object.freeze([
  ".orchestra/state/**",
  ".codex/orchestra-state/**",
  ".codex/orchestra-telemetry/**",
  ".codex/orchestra-artifacts/**",
  ".codex/orchestra-semantic/**",
  ".codex/runtime-management/**",
  ".agents/state/**",
  ".agents/telemetry/**",
  ".agents/dream-data/**",
  ".agents/artifacts/**",
  ".agents/semantic/**",
  ".agents/runtime-management/**",
]);
const BLOCK = `${START}\n${MANAGED_PATTERNS.join("\n")}\n${END}`;

function replaceManagedBlock(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start >= 0 && end >= start) {
    const after = end + END.length;
    return text.slice(0, start) + BLOCK + text.slice(after);
  }
  const prefix = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
  return `${prefix}${BLOCK}\n`;
}

function resolveInfoExclude(targetDir) {
  try {
    const gitPath = execFileSync(
      "git",
      ["-C", targetDir, "rev-parse", "--git-path", "info/exclude"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!gitPath) return null;
    return isAbsolute(gitPath) ? gitPath : resolve(targetDir, gitPath);
  } catch {
    return null;
  }
}

export function ensureProjectStateIgnored(targetDir) {
  const path = resolveInfoExclude(targetDir);
  if (!path) {
    return { changed: false, path: null, reason: "GIT_METADATA_UNAVAILABLE" };
  }
  mkdirSync(dirname(path), { recursive: true });
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = replaceManagedBlock(before);
  const normalized = after.endsWith("\n") ? after : `${after}\n`;
  if (normalized === before) return { changed: false, path, reason: null };
  writeFileSync(path, normalized, "utf8");
  return { changed: true, path, reason: null };
}

export { MANAGED_PATTERNS as ORCHESTRA_LOCAL_STATE_IGNORE_PATTERNS };
