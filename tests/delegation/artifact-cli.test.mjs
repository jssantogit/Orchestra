import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function loadArtifactCli() {
  try {
    return await import("../../runtime/delegation/artifact-cli.mjs");
  } catch {
    return null;
  }
}

function sink() {
  let value = "";
  return {
    write(chunk) { value += String(chunk); },
    text() { return value; },
  };
}

function promoteArgs(action = "promote") {
  return [
    action,
    "--artifact", "artifact-1",
    "--repo-root", join(tmpdir(), "orchestra-artifact-cli-repo"),
    "--generation", "7",
    "--source-provider", "codex",
    "--actor-id-hash", "sha256:control",
  ];
}

test("artifact CLI exposes inspect without constructing CONTROL authority", async () => {
  const module = await loadArtifactCli();
  assert.equal(typeof module?.runArtifactCli, "function", "runArtifactCli must exist");

  const stdout = sink();
  const stderr = sink();
  let observed = null;
  const exitCode = await module.runArtifactCli({
    argv: [
      "inspect",
      "--artifact", "artifact-1",
      "--repo-root", join(tmpdir(), "orchestra-artifact-cli-repo"),
    ],
    stdout,
    stderr,
    inspectArtifact: async (facts) => {
      observed = facts;
      return {
        manifest: { artifactId: "artifact-1", state: "READY_FOR_REVIEW" },
        integrity: { valid: true, reason: null },
        reviewPath: "/tmp/review",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  assert.deepEqual(observed, {
    repoRoot: resolve(join(tmpdir(), "orchestra-artifact-cli-repo")),
    artifactId: "artifact-1",
  });
  assert.deepEqual(JSON.parse(stdout.text()), {
    manifest: { artifactId: "artifact-1", state: "READY_FOR_REVIEW" },
    integrity: { valid: true, reason: null },
    reviewPath: "/tmp/review",
  });
});

test("artifact CLI promote constructs root CONTROL only from explicit caller facts", async () => {
  const module = await loadArtifactCli();
  assert.equal(typeof module?.runArtifactCli, "function", "runArtifactCli must exist");

  const stdout = sink();
  const stderr = sink();
  let observed = null;
  const exitCode = await module.runArtifactCli({
    argv: promoteArgs("promote"),
    stdout,
    stderr,
    promoteArtifact: async (facts) => {
      observed = facts;
      return { promoted: true, reason: null, changedPaths: ["src/a.mjs"] };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  assert.deepEqual(observed, {
    repoRoot: resolve(join(tmpdir(), "orchestra-artifact-cli-repo")),
    artifactId: "artifact-1",
    generation: 7,
    actor: {
      provider: "codex",
      actorIdHash: "sha256:control",
      actorKind: "ROOT",
      isRoot: true,
    },
  });
  assert.deepEqual(JSON.parse(stdout.text()), {
    promoted: true,
    reason: null,
    changedPaths: ["src/a.mjs"],
  });
});

test("artifact CLI discard passes the same explicit CONTROL identity", async () => {
  const module = await loadArtifactCli();
  assert.equal(typeof module?.runArtifactCli, "function", "runArtifactCli must exist");

  let observed = null;
  const stdout = sink();
  const stderr = sink();
  const exitCode = await module.runArtifactCli({
    argv: promoteArgs("discard"),
    stdout,
    stderr,
    discardArtifact: async (facts) => {
      observed = facts;
      return { discarded: true, reason: null };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  assert.equal(observed.generation, 7);
  assert.deepEqual(observed.actor, {
    provider: "codex",
    actorIdHash: "sha256:control",
    actorKind: "ROOT",
    isRoot: true,
  });
  assert.deepEqual(JSON.parse(stdout.text()), { discarded: true, reason: null });
});

test("artifact CLI rejects malformed flags, unsafe artifact IDs, and implicit authority", async () => {
  const module = await loadArtifactCli();
  assert.equal(typeof module?.runArtifactCli, "function", "runArtifactCli must exist");

  const cases = [
    ["inspect", "--artifact", "../escape", "--repo-root", "/repo"],
    ["promote", "--artifact", "artifact-1", "--repo-root", "/repo", "--generation", "7", "--source-provider", "codex"],
    ["discard", "--artifact", "artifact-1", "--repo-root", "/repo", "--generation", "-1", "--source-provider", "codex", "--actor-id-hash", "sha256:control"],
    ["unknown", "--artifact", "artifact-1", "--repo-root", "/repo"],
  ];

  for (const argv of cases) {
    const stdout = sink();
    const stderr = sink();
    const exitCode = await module.runArtifactCli({ argv, stdout, stderr });
    assert.equal(exitCode, 2, argv.join(" "));
    assert.equal(stdout.text(), "");
    assert.equal(stderr.text(), "ORCHESTRA_DELEGATION_ARTIFACT_CLI_USAGE_INVALID\n");
  }
});

test("artifact CLI denies invocation from a delegated worker context", async () => {
  const module = await loadArtifactCli();
  assert.equal(typeof module?.runArtifactCli, "function", "runArtifactCli must exist");

  let called = false;
  const stdout = sink();
  const stderr = sink();
  const exitCode = await module.runArtifactCli({
    argv: promoteArgs("promote"),
    stdout,
    stderr,
    env: { ORCHESTRA_DELEGATION_ACTIVE: "1", ORCHESTRA_DELEGATION_DEPTH: "1" },
    promoteArtifact: async () => {
      called = true;
      return { promoted: true, reason: null, changedPaths: [] };
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(called, false);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "ORCHESTRA_DELEGATION_ARTIFACT_CLI_RECURSION_DENIED\n");
});

test("artifact CLI maps lifecycle exceptions to a bounded execution failure", async () => {
  const module = await loadArtifactCli();
  assert.equal(typeof module?.runArtifactCli, "function", "runArtifactCli must exist");

  const stdout = sink();
  const stderr = sink();
  const exitCode = await module.runArtifactCli({
    argv: promoteArgs("promote"),
    stdout,
    stderr,
    promoteArtifact: async () => { throw new Error("sensitive internal detail"); },
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "ORCHESTRA_DELEGATION_ARTIFACT_CLI_EXECUTION_FAILED\n");
});
