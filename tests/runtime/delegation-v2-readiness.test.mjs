import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectDelegationCapabilities } from "../../runtime/delegation/discovery.mjs";
import { loadRuntimeManifest } from "../../runtime/manifest-loader.mjs";
import { runDoctor } from "../../runtime/doctor.mjs";

function processResult(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

function healthyProviderProcess(input) {
  if (input.command === "agy" && input.args[0] === "--version") {
    return processResult({ stdout: "agy 1.2.3\n" });
  }
  if (input.command === "agy") {
    return processResult({ stdout: "--print --print-timeout --sandbox --model --mode\n" });
  }
  if (input.command === "codex" && input.args[0] === "--version") {
    return processResult({ stdout: "codex-cli 0.130.0\n" });
  }
  if (input.command === "codex") {
    return processResult({ stdout: "--model --sandbox --ask-for-approval --config --output-schema --output-last-message\n" });
  }
  return null;
}

function doctorFixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-v2-readiness-doctor-"));
  mkdirSync(join(root, "runtime", "manifests"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.1.0" }));
  writeFileSync(join(root, "src", "entry.mjs"), "export const ok = true;\n");
  writeFileSync(join(root, "runtime", "manifests", "fixture.json"), JSON.stringify({
    schema: "orchestra.runtime-manifest.v1",
    runtime: "fixture",
    version: "1.1.0",
    sourceRoots: ["src"],
    managedAssets: [{ source: "src/entry.mjs", output: "dist/entry.mjs", type: "file" }],
    preservedProjectPaths: [".orchestra/state"],
    generatedInputs: ["src/entry.mjs"],
    entrypoints: ["dist/entry.mjs"],
  }));
  return root;
}

test("delegation manifest exposes artifact lifecycle entrypoint and preserves sealed artifact state", async () => {
  const manifest = await loadRuntimeManifest("delegation");
  assert.ok(manifest.entrypoints.includes(
    ".orchestra/runtime/delegation/runtime/delegation/artifact-cli.mjs",
  ));
  assert.ok(manifest.entrypoints.includes(
    ".orchestra/runtime/delegation/runtime/delegation/parallel-cli.mjs",
  ));
  assert.ok(manifest.preservedProjectPaths.includes(".orchestra/state/delegations"));
  assert.ok(manifest.preservedProjectPaths.includes(".orchestra/state/delegation/artifacts"));
  assert.ok(manifest.preservedProjectPaths.includes(".orchestra/state/delegation/parallel-groups"));
  assert.ok(manifest.preservedProjectPaths.includes(".orchestra/state/delegation/composite-artifacts"));
});

test("delegation discovery reports read-only and implementation workspace prerequisites independently", async () => {
  const calls = [];
  const result = await inspectDelegationCapabilities({
    runProcess: async (input) => {
      calls.push({ command: input.command, args: input.args });
      if (input.command === "git" && input.args[0] === "worktree") {
        return processResult({ stdout: "worktree /repo\nHEAD abcdef\n" });
      }
      if (input.command === "git" && input.args[0] === "clone") {
        return processResult({
          exitCode: 129,
          stderr: "usage: git clone [<options>] <repo> [<dir>]\n    --no-hardlinks\n",
        });
      }
      const provider = healthyProviderProcess(input);
      if (provider) return provider;
      throw new Error("unexpected command");
    },
  });

  assert.equal(result.status, "READY");
  assert.deepEqual(result.gitWorktree, { available: true });
  assert.deepEqual(result.gitClone, { available: true, noHardlinks: true });
  assert.deepEqual(result.modes, {
    review: { status: "READY", isolation: "EPHEMERAL_WORKTREE" },
    implementation: {
      status: "READY",
      isolation: "EPHEMERAL_CLONE",
      artifactLifecycle: "CONTROL_OWNED",
    },
    parallelImplementation: {
      status: "READY",
      isolation: "EPHEMERAL_CLONE",
      memberCount: 2,
      artifactLifecycle: "CONTROL_OWNED_COMPOSITE",
    },
  });
  assert.ok(calls.some((call) => call.command === "git" && call.args.join(" ") === "clone -h"));
});

test("implementation readiness fails closed when hardened clone capability is absent without breaking read-only readiness", async () => {
  const result = await inspectDelegationCapabilities({
    runProcess: async (input) => {
      if (input.command === "git" && input.args[0] === "worktree") return processResult();
      if (input.command === "git" && input.args[0] === "clone") {
        return processResult({ exitCode: 129, stderr: "usage: git clone <repo>\n" });
      }
      const provider = healthyProviderProcess(input);
      if (provider) return provider;
      throw new Error("unexpected command");
    },
  });

  assert.equal(result.status, "READY");
  assert.equal(result.modes.review.status, "READY");
  assert.equal(result.modes.implementation.status, "UNAVAILABLE");
  assert.equal(result.modes.parallelImplementation.status, "UNAVAILABLE");
  assert.equal(result.gitClone.available, false);
});

test("Doctor normalizes per-mode delegation readiness as advisory structural information", async (t) => {
  const root = doctorFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = await runDoctor({
    repoRoot: root,
    runtime: "fixture",
    runCommands: false,
    delegationInspector: async () => ({
      status: "DEGRADED",
      gitWorktree: { available: true },
      gitClone: { available: false, noHardlinks: false },
      providers: [
        { provider: "codex", available: true, version: "codex-cli 0.130.0" },
        { provider: "antigravity", available: false, reason: "PROVIDER_UNAVAILABLE" },
      ],
    }),
  });

  assert.equal(report.healthy, true);
  assert.deepEqual(report.delegation.modes, {
    review: { status: "DEGRADED", isolation: "EPHEMERAL_WORKTREE" },
    implementation: {
      status: "UNAVAILABLE",
      isolation: "EPHEMERAL_CLONE",
      artifactLifecycle: "CONTROL_OWNED",
    },
    parallelImplementation: {
      status: "UNAVAILABLE",
      isolation: "EPHEMERAL_CLONE",
      memberCount: 2,
      artifactLifecycle: "CONTROL_OWNED_COMPOSITE",
    },
  });
});
