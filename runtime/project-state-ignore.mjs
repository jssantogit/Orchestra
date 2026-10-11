import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const START = "# >>> orchestra managed state >>>";
const END = "# <<< orchestra managed state <<<";
const BLOCK = `${START}\n.orchestra/state/**\n${END}`;

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

export function ensureProjectStateIgnored(targetDir) {
  const infoDir = join(targetDir, ".git", "info");
  const path = join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = replaceManagedBlock(before);
  const normalized = after.endsWith("\n") ? after : `${after}\n`;
  if (normalized === before) return { changed: false, path };
  writeFileSync(path, normalized, "utf8");
  return { changed: true, path };
}
