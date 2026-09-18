import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enforceExplorationToolBoundary } from "../dream/exploration-lab.mjs";

function parseWorkspacePath(value) {
  if (!value || typeof value !== "string") return "";
  if (value.startsWith("file://")) {
    try { return fileURLToPath(value); } catch {}
  }
  return value;
}

function repoRoot(payload = {}) {
  const raw = payload.workspacePaths?.[0] || payload.workspaceUris?.[0] || null;
  if (raw) return resolve(parseWorkspacePath(raw));
  const cwd = process.cwd();
  if (basename(cwd) === ".agents") return resolve(cwd, "..");
  if (existsSync(resolve(cwd, ".agents"))) return cwd;
  if (existsSync(resolve(cwd, "../.agents"))) return resolve(cwd, "..");
  return cwd;
}

function main() {
  let payload;
  try {
    const raw = readFileSync(0, "utf8");
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // This hook owns only Exploration Lab confinement. The primary governance
    // hook remains responsible for malformed normal-runtime authorization.
    console.log(JSON.stringify({}));
    return;
  }

  const toolCall = payload?.toolCall && typeof payload.toolCall === "object"
    ? payload.toolCall
    : (
      typeof payload?.toolName === "string"
        ? { name: payload.toolName, args: payload.toolArgs || payload.args || {} }
        : null
    );

  if (!toolCall?.name) {
    console.log(JSON.stringify({}));
    return;
  }

  const result = enforceExplorationToolBoundary({
    repoRoot: repoRoot(payload),
    toolName: String(toolCall.name),
    toolArgs: toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {},
  });

  if (!result.active || result.allowed) {
    console.log(JSON.stringify({}));
    return;
  }

  console.log(JSON.stringify({
    decision: "deny",
    reason: result.reason || "EXPLORATION_BOUNDARY_DENIED",
  }));
}

main();
