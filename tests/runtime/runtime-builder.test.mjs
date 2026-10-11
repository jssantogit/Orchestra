import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import test from "node:test";

import { buildRuntime } from "../../runtime/runtime-builder.mjs";

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, absolute));
    else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
  }
  return files.sort();
}

function importSpecifiers(source) {
  const specs = [];
  const pattern = /(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) specs.push(match[1] || match[2]);
  return specs;
}

async function assertSelfContained(root) {
  const files = await walkFiles(root);
  for (const file of files) {
    if (![".mjs", ".js"].includes(extname(file))) continue;
    const absolute = join(root, file);
    const source = await readFile(absolute, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        assert.fail(`${file} has external package import ${specifier}`);
      }
      const target = resolve(dirname(absolute), specifier);
      assert.ok(
        target === root || target.startsWith(`${root}${sep}`),
        `${file} import escapes built runtime: ${specifier}`,
      );
    }
  }
}

test("builder emits deterministic self-contained provider runtimes from manifests", async () => {
  const base = await mkdtemp(join(tmpdir(), "orchestra-runtime-builder-"));
  try {
    const codexA = join(base, "codex-a");
    const codexB = join(base, "codex-b");
    const agy = join(base, "antigravity");

    const first = await buildRuntime({ runtime: "codex", outputDir: codexA });
    const second = await buildRuntime({ runtime: "codex", outputDir: codexB });
    const antigravity = await buildRuntime({ runtime: "antigravity", outputDir: agy });

    assert.equal(first.runtime, "codex");
    assert.equal(first.version, "0.10.0");
    assert.match(first.manifestHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(first, second);
    assert.deepEqual(first.files, [...first.files].sort((a, b) => a.path.localeCompare(b.path)));
    assert.equal(antigravity.runtime, "antigravity");

    const codexFiles = await walkFiles(codexA);
    const agyFiles = await walkFiles(agy);
    assert.ok(codexFiles.includes(".codex/astra-orchestra/core/schema/generated/implementation-packet.v1.mjs"));
    assert.ok(codexFiles.includes(".codex/astra-orchestra/core/schemas/implementation-packet.v1.schema.json"));
    assert.ok(agyFiles.includes(".agents/skills/orchestra/core/schema/generated/implementation-packet.v1.mjs"));
    assert.ok(agyFiles.includes(".agents/skills/orchestra/core/schemas/implementation-packet.v1.schema.json"));
    assert.ok(codexFiles.includes("orchestra-runtime-build.json"));
    assert.ok(agyFiles.includes("orchestra-runtime-build.json"));

    const codexCatalog = await readFile(join(codexA, ".codex/astra-orchestra/provider/codex/model-catalog.mjs"), "utf8");
    const agyCatalog = await readFile(join(agy, ".agents/skills/orchestra/provider/antigravity/model-catalog.mjs"), "utf8");
    assert.match(codexCatalog, /gpt-6-/);
    assert.doesNotMatch(codexCatalog, /gemini-3\.8-/);
    assert.match(agyCatalog, /gemini-3\.8-/);
    assert.doesNotMatch(agyCatalog, /gpt-6-/);

    const metadata = JSON.parse(await readFile(join(codexA, "orchestra-runtime-build.json"), "utf8"));
    assert.deepEqual(metadata, first);
    assert.ok(!("builtAt" in metadata));
    assert.ok(!("timestamp" in metadata));

    await assertSelfContained(codexA);
    await assertSelfContained(agy);

    const mode = (await lstat(join(codexA, ".codex/astra-orchestra/codex-runtime-cli.mjs"))).mode & 0o777;
    assert.ok(mode & 0o100, "runtime CLI should remain owner-executable");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
