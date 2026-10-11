import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeManifest } from "../../runtime/manifest-loader.mjs";
import { buildRuntime } from "../../runtime/runtime-builder.mjs";
import {
  inspectProjectRuntime,
  installProjectRuntime,
  rollbackProjectRuntime,
  updateProjectRuntime,
} from "../../runtime/project-runtime-manager.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function makeGitProject(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  git(root, "init", "-q");
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await writeFile(join(root, ".git", "info", "exclude"), "# user rule\n*.scratch\n", "utf8");
  await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
  git(root, "add", ".gitignore");
  git(root, "-c", "user.name=Orchestra Test", "-c", "user.email=orchestra@example.invalid", "commit", "-qm", "fixture");
  return root;
}

async function cloneBuiltRuntime(source, target, markerPath, marker) {
  await cp(source, target, { recursive: true, dereference: false, preserveTimestamps: true });
  await writeFile(join(target, markerPath), marker, "utf8");
}

for (const fixture of [
  {
    runtime: "codex",
    marker: ".codex/astra-orchestra/routing-policy.mjs",
    stateFile: ".codex/orchestra-telemetry/events.jsonl",
    managedProbe: ".codex/config.toml",
  },
  {
    runtime: "antigravity",
    marker: ".agents/skills/orchestra/routing-policy.mjs",
    stateFile: ".agents/telemetry/events.jsonl",
    managedProbe: ".agents/hooks.json",
  },
]) {
  test(`${fixture.runtime}: shared manifest manager installs built image and preserves project state`, async () => {
    const temp = await mkdtemp(join(tmpdir(), `orchestra-${fixture.runtime}-manager-`));
    const project = await makeGitProject(`orchestra-${fixture.runtime}-project-`);
    const builtV1 = join(temp, "built-v1");
    const builtV2 = join(temp, "built-v2");
    try {
      const manifest = await loadRuntimeManifest(fixture.runtime);
      await buildRuntime({ runtime: fixture.runtime, outputDir: builtV1 });
      const originalMarker = await readFile(join(builtV1, fixture.marker), "utf8");
      await cloneBuiltRuntime(builtV1, builtV2, fixture.marker, `${originalMarker}\n// fixture-v2\n`);

      const installed = await installProjectRuntime({ targetDir: project, runtimeManifest: manifest, builtRuntime: builtV1 });
      assert.equal(installed.operation, "install");
      assert.equal((await inspectProjectRuntime({ targetDir: project, runtimeManifest: manifest, builtRuntime: builtV1 })).clean, true);
      assert.equal(await readFile(join(project, fixture.managedProbe), "utf8"), await readFile(join(builtV1, fixture.managedProbe), "utf8"));

      await mkdir(join(project, fixture.stateFile, ".."), { recursive: true });
      await writeFile(join(project, fixture.stateFile), "{\"keep\":true}\n", "utf8");
      await mkdir(join(project, ".orchestra", "state"), { recursive: true });
      await writeFile(join(project, ".orchestra", "state", "lease.json"), "{\"keep\":true}\n", "utf8");

      const exclude = await readFile(join(project, ".git", "info", "exclude"), "utf8");
      assert.match(exclude, /# user rule\n\*\.scratch\n/);
      assert.match(exclude, /# >>> orchestra managed state >>>/);
      assert.match(exclude, /\.orchestra\/state\/\*\*/);
      assert.match(exclude, new RegExp(fixture.stateFile.split("/").slice(0, -1).join("\\/").replaceAll(".", "\\.") + "/\\*\\*"));
      assert.equal(git(project, "status", "--short"), "");

      const dry = await updateProjectRuntime({ targetDir: project, runtimeManifest: manifest, builtRuntime: builtV2, dryRun: true });
      assert.equal(dry.changed, true);
      assert.equal((await readFile(join(project, fixture.marker), "utf8")).includes("fixture-v2"), false);

      const updated = await updateProjectRuntime({ targetDir: project, runtimeManifest: manifest, builtRuntime: builtV2 });
      assert.equal(updated.changed, true);
      assert.ok(updated.backupId);
      assert.match(await readFile(join(project, fixture.marker), "utf8"), /fixture-v2/);
      assert.equal(await readFile(join(project, fixture.stateFile), "utf8"), "{\"keep\":true}\n");
      assert.equal(await readFile(join(project, ".orchestra", "state", "lease.json"), "utf8"), "{\"keep\":true}\n");

      await writeFile(join(project, fixture.stateFile), "{\"keep\":\"new\"}\n", "utf8");
      const rolled = await rollbackProjectRuntime({ targetDir: project, runtimeManifest: manifest, backupId: updated.backupId });
      assert.equal(rolled.operation, "rollback");
      assert.equal((await readFile(join(project, fixture.marker), "utf8")).includes("fixture-v2"), false);
      assert.equal(await readFile(join(project, fixture.stateFile), "utf8"), "{\"keep\":\"new\"}\n");
      assert.equal(git(project, "status", "--short"), "");
    } finally {
      await rm(temp, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
}
