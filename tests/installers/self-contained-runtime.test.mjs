import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function listInstalledModules(root, current = root) {
  const modules = [];
  const entries = readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) modules.push(...listInstalledModules(root, absolute));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) modules.push(pathToFileURL(absolute).href);
  }
  return modules.sort();
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

      const providerRoot = join(target, layout.provider);
      const providerModuleUrls = listInstalledModules(providerRoot);
      assert.equal(providerModuleUrls.length > 0, true);
      assert.equal(existsSync(join(providerRoot, "delegation-executor.mjs")), false);

      const runner = join(target, "self-contained-smoke.mjs");
      const validatorUrl = pathToFileURL(join(target, layout.core, "schema", "validator.mjs")).href;
      const catalogUrl = pathToFileURL(join(target, layout.provider, "model-catalog.mjs")).href;
      const adapterUrl = pathToFileURL(join(target, layout.provider, "adapter", "session.mjs")).href;
      writeFileSync(runner, [
        `for (const url of ${JSON.stringify(providerModuleUrls)}) await import(url);`,
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

test("delegation installed runtime is self-contained and contains no provider control-plane trees", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-self-contained-delegation-"));
  const target = join(root, "project");
  const builtRuntime = join(root, "built-runtime");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(target, { recursive: true }));
    git(target, "init", "-q");
    git(target, "config", "user.name", "Test");
    git(target, "config", "user.email", "test@example.invalid");

    await buildRuntime({ runtime: "delegation", outputDir: builtRuntime });
    const runtimeManifest = await loadRuntimeManifest("delegation");
    await installProjectRuntime({ targetDir: target, runtimeManifest, builtRuntime });

    const runtimeRoot = join(target, ".orchestra", "runtime", "delegation");
    const runner = join(target, "delegation-self-contained-smoke.mjs");
    const cliUrl = pathToFileURL(join(runtimeRoot, "runtime", "delegation", "cli.mjs")).href;
    const brokerUrl = pathToFileURL(join(runtimeRoot, "runtime", "delegation", "broker.mjs")).href;
    const antigravityExecutorUrl = pathToFileURL(join(runtimeRoot, "providers", "antigravity", "delegation-executor.mjs")).href;
    const codexExecutorUrl = pathToFileURL(join(runtimeRoot, "providers", "codex", "delegation-executor.mjs")).href;
    const domainUrl = pathToFileURL(join(runtimeRoot, "core", "domain", "delegation.mjs")).href;
    writeFileSync(runner, [
      `const cli = await import(${JSON.stringify(cliUrl)});`,
      `const broker = await import(${JSON.stringify(brokerUrl)});`,
      `const antigravityExecutor = await import(${JSON.stringify(antigravityExecutorUrl)});`,
      `const codexExecutor = await import(${JSON.stringify(codexExecutorUrl)});`,
      `const domain = await import(${JSON.stringify(domainUrl)});`,
      `if (typeof cli.runDelegationCli !== "function") throw new Error("DELEGATION_CLI_BROKEN");`,
      `if (typeof broker.createDelegationBroker !== "function") throw new Error("DELEGATION_BROKER_BROKEN");`,
      `if (typeof antigravityExecutor.createAntigravityDelegationExecutor !== "function") throw new Error("ANTIGRAVITY_DELEGATION_EXECUTOR_BROKEN");`,
      `if (typeof codexExecutor.createCodexDelegationExecutor !== "function") throw new Error("CODEX_DELEGATION_EXECUTOR_BROKEN");`,
      `if (typeof domain.assertDelegationRequest !== "function") throw new Error("DELEGATION_DOMAIN_BROKEN");`,
    ].join("\n") + "\n");

    const env = { ...process.env, NODE_PATH: "", ORCHESTRA_ROOT: "", ORCHESTRA_SOURCE_ROOT: "" };
    execFileSync(process.execPath, [runner], { cwd: target, env, encoding: "utf8" });

    assert.equal(existsSync(join(target, ".codex")), false);
    assert.equal(existsSync(join(target, ".agents")), false);
    assert.equal(existsSync(join(target, "GEMINI.md")), false);
    assert.equal(existsSync(join(runtimeRoot, "providers", "codex", "adapter")), false);
    assert.equal(existsSync(join(runtimeRoot, "providers", "antigravity", "adapter")), false);
    assert.equal(git(target, "status", "--short", "--", ".orchestra/state"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
