import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { loadRuntimeManifest } from "../../runtime/manifest-loader.mjs";
import { buildRuntime } from "../../runtime/runtime-builder.mjs";
import { installProjectRuntime } from "../../runtime/project-runtime-manager.mjs";

const PROVIDERS = Object.freeze({
  codex: {
    core: ".codex/astra-orchestra/core",
    provider: ".codex/astra-orchestra/provider/codex",
  },
  antigravity: {
    core: ".agents/skills/orchestra/core",
    provider: ".agents/skills/orchestra/provider/antigravity",
  },
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

for (const [runtime, layout] of Object.entries(PROVIDERS)) {
  test(`${runtime} installed runtime is self-contained`, async () => {
    const root = mkdtempSync(join(tmpdir(), `orchestra-self-contained-${runtime}-`));
    const target = join(root, "project");
    const builtRuntime = join(root, "built-runtime");
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(target, { recursive: true }));
      git(target, "init", "-q");
      git(target, "config", "user.name", "Test");
      git(target, "config", "user.email", "test@example.invalid");

      await buildRuntime({ runtime, outputDir: builtRuntime });
      const runtimeManifest = await loadRuntimeManifest(runtime);
      await installProjectRuntime({ targetDir: target, runtimeManifest, builtRuntime });

      const runner = join(target, "self-contained-smoke.mjs");
      const validatorUrl = pathToFileURL(join(target, layout.core, "schema", "validator.mjs")).href;
      const catalogUrl = pathToFileURL(join(target, layout.provider, "model-catalog.mjs")).href;
      const adapterUrl = pathToFileURL(join(target, layout.provider, "adapter", "session.mjs")).href;
      writeFileSync(runner, [
        `const validator = await import(${JSON.stringify(validatorUrl)});`,
        `const catalog = await import(${JSON.stringify(catalogUrl)});`,
        `const adapter = await import(${JSON.stringify(adapterUrl)});`,
        `const schema = validator.validateSchema("candidate.v1.schema.json", {});`,
        `if (schema.valid !== false || !Array.isArray(schema.errors)) throw new Error("SCHEMA_RUNTIME_BROKEN");`,
        `const profile = catalog.resolveModelProfile("CONTROL");`,
        `if (profile.logicalRole !== "CONTROL" || !profile.model) throw new Error("MODEL_CATALOG_BROKEN");`,
        `if (!adapter || Object.keys(adapter).length === 0) throw new Error("PROVIDER_ADAPTER_BROKEN");`,
      ].join("\n") + "\n");

      const env = { ...process.env, NODE_PATH: "", ORCHESTRA_ROOT: "", ORCHESTRA_SOURCE_ROOT: "" };
      execFileSync(process.execPath, [runner], { cwd: target, env, encoding: "utf8" });

      assert.equal(git(target, "status", "--short", "--", ".orchestra/state"), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
