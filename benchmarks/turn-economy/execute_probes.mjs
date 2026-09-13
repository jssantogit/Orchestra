import { runAgyProbe } from "./probes.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const resultsDir = resolve(__dirname, "results");
mkdirSync(resultsDir, { recursive: true });

const probes = [
  {
    probeId: "probe-a-two-reads",
    name: "PROBE A — TWO INDEPENDENT READS",
    prompt: "Inspect src/parser.js and src/formatter.js. Use the available file-reading tools. Do not modify anything. Inspect both before responding.",
  },
  {
    probeId: "probe-b-search-read",
    name: "PROBE B — SEARCH + READ",
    prompt: "Find the implementation of formatNumber and inspect the surrounding code. Do not modify anything.",
  },
  {
    probeId: "probe-c-parallel-read",
    name: "PROBE C — PARALLEL READ POSSIBILITY",
    prompt: "Read the first 10 lines of src/parser.js and the first 10 lines of src/formatter.js in parallel if supported. Do not modify anything.",
  },
  {
    probeId: "probe-worker-delegation",
    name: "PROBE WORKER — AGY WORKER OBSERVABILITY",
    prompt: "According to orchestra routing policy, this task is an IMPLEMENTATION task. Create an implementation scope contract and invoke the flash-worker subagent using invoke_subagent to inspect src/formatter.js and test/formatter.test.js. Do not edit product code directly.",
  },
];

console.log("Starting Antigravity Capability Probes (4 probes max)...");
const results = [];

for (const p of probes) {
  try {
    const res = runAgyProbe(p);
    results.push(res);
    console.log(`PROBE RESULT [${res.probeId}]:`);
    console.log(`  Status: ${res.status}`);
    console.log(`  Model Turns: ${res.modelTurnsCount}`);
    console.log(`  Tools per turn list: ${JSON.stringify(res.toolsPerTurnList)}`);
    console.log(`  Max tools in single turn: ${res.maxToolsInSingleTurn}`);
    console.log(`  Multi-tool observed: ${res.multiToolObserved}`);
    console.log(`  Subagents invoked: ${res.subagentsCount}`);
    console.log(`  Usage: ${JSON.stringify(res.usage)}`);

    // Check quota / error
    if (res.status === "FAILED" || res.exitCode !== 0) {
      console.warn(`Probe ${res.probeId} failed or exited with code ${res.exitCode}`);
    }
  } catch (err) {
    console.error(`Error running probe ${p.probeId}:`, err);
    results.push({
      probeId: p.probeId,
      name: p.name,
      error: err.message,
    });
    break;
  }
}

const outputFile = resolve(resultsDir, "probe-results.json");
writeFileSync(outputFile, JSON.stringify(results, null, 2), "utf8");
console.log(`\nAll probe results saved to: ${outputFile}`);
