import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const orchestraRoot = fileURLToPath(new URL("../../", import.meta.url));
const cases = [
  {
    name: "Codex",
    install: join(orchestraRoot, "scripts", "install-codex.mjs"),
    project: join(orchestraRoot, "scripts", "orchestra-codex-project.mjs"),
  },
  {
    name: "Antigravity",
    install: join(orchestraRoot, "scripts", "install-antigravity.mjs"),
    project: join(orchestraRoot, "scripts", "orchestra-project.mjs"),
  },
];

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: orchestraRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
}

for (const entry of cases) {
  test(`${entry.name} project doctor reports drift in the installed neutral delegation runtime`, (t) => {
    const target = mkdtempSync(join(tmpdir(), `orchestra-${entry.name.toLowerCase()}-doctor-`));
    t.after(() => rmSync(target, { recursive: true, force: true }));

    const installed = run(entry.install, [target]);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);

    appendFileSync(
      join(target, ".orchestra", "runtime", "delegation", "runtime", "delegation", "cli.mjs"),
      "\n// deliberate neutral runtime drift\n",
    );

    const doctor = run(entry.project, ["doctor", target, "--json"]);
    assert.equal(doctor.status, 1, doctor.stderr || doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.healthy, false);
    assert.equal(report.delegationRuntime.clean, false);
    assert.equal(report.checks.some((check) => check.id === "DELEGATION_RUNTIME_INTEGRITY" && check.ok === false), true);
  });
}
