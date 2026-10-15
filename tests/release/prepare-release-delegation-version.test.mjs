import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { prepareRelease } from "../../scripts/release/prepare-release.mjs";

test("prepareRelease keeps every canonical runtime manifest version coherent", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-release-delegation-version-"));
  try {
    mkdirSync(join(root, "runtime/manifests"), { recursive: true });
    mkdirSync(join(root, "docs/release"), { recursive: true });
    writeFileSync(join(root, "package.json"), `${JSON.stringify({
      name: "orchestra",
      version: "1.0.1",
      scripts: {},
    }, null, 2)}\n`);
    writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({
      name: "orchestra",
      version: "1.0.1",
      lockfileVersion: 3,
      packages: { "": { name: "orchestra", version: "1.0.1" } },
    }, null, 2)}\n`);

    for (const runtime of ["core", "codex", "antigravity", "delegation"]) {
      writeFileSync(join(root, `runtime/manifests/${runtime}.json`), `${JSON.stringify({
        runtime,
        version: "1.0.1",
      }, null, 2)}\n`);
    }

    prepareRelease({
      repoRoot: root,
      bump: "minor",
      baseTag: "v1.0.1",
      commits: [],
      generatedAt: "2026-10-14T18:00:00.000Z",
    });

    for (const runtime of ["core", "codex", "antigravity", "delegation"]) {
      const manifest = JSON.parse(readFileSync(join(root, `runtime/manifests/${runtime}.json`), "utf8"));
      assert.equal(manifest.version, "1.1.0", `${runtime} manifest must match the prepared package version`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
