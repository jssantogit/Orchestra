import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export {
  startPendingInvestigationRequirement,
  classifyOrchestratorHandoffControlCommand,
  isValidAgentName,
} from "./pre-tool-enforce-legacy.mjs";

const legacyHook = resolve(dirname(fileURLToPath(import.meta.url)), "pre-tool-enforce-legacy.mjs");

function main() {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch {}
  const result = spawnSync(process.execPath, [legacyHook], {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.status ?? (result.error ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
