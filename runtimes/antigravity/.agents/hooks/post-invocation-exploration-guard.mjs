import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordExplorationModelCall } from "../dream/exploration-lab.mjs";

function root(payload = {}) {
  const raw = payload.workspacePaths?.[0] || payload.workspaceUris?.[0] || null;
  if (raw) {
    if (String(raw).startsWith("file://")) {
      try { return resolve(fileURLToPath(raw)); } catch {}
    }
    return resolve(String(raw));
  }
  const cwd = process.cwd();
  if (basename(cwd) === ".agents") return resolve(cwd, "..");
  if (existsSync(resolve(cwd, ".agents"))) return cwd;
  if (existsSync(resolve(cwd, "../.agents"))) return resolve(cwd, "..");
  return cwd;
}
function main() {
  let payload = {};
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }
  const result = recordExplorationModelCall({ repoRoot: root(payload), payload });
  if (!result.active || !result.terminate) {
    console.log(JSON.stringify({}));
    return;
  }
  console.log(JSON.stringify({
    terminationBehavior: "terminate",
    injectSteps: [{
      ephemeralMessage: result.reason + ": Milestone E exploration stopped after " + result.model_calls + " model call(s). The branch budget is immutable.",
    }],
  }));
}
main();
