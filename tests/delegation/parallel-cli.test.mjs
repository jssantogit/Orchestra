import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function loadParallelCli() {
  try {
    return await import("../../runtime/delegation/parallel-cli.mjs");
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

function packet(taskId = "task-parallel", generation = 7) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId,
    candidateGeneration: generation,
    goal: "implement bounded shard",
    direction: { change: "change shard", preserve: ["other shard"] },
    anchors: [{ file: "src/example.mjs" }],
    scope: { allowedAreas: ["src/**"], forbidden: [] },
    permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: [] },
    validation: ["focused tests"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function group() {
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: "parallel-group-1",
    taskId: "task-parallel",
    generation: 7,
    source: { provider: "codex", actorIdHash: "sha256:control" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
    members: [
      {
        memberId: "local",
        targetProvider: "codex",
        packet: packet(),
        mutationScope: { allowedPaths: ["src/home/**"], forbiddenPaths: [] },
      },
      {
        memberId: "external",
        targetProvider: "antigravity",
        packet: packet(),
        mutationScope: { allowedPaths: ["src/library/**"], forbiddenPaths: [] },
      },
    ],
  };
}

function withGroupFile(value, fn) {
  const dir = mkdtempSync(join(tmpdir(), "orchestra-parallel-cli-"));
  const path = join(dir, "group.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
  return Promise.resolve(fn(path)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function mutationArgs(action = "promote") {
  return [
    action,
    "--artifact", "composite-1",
    "--repo-root", join(tmpdir(), "orchestra-parallel-cli-repo"),
    "--generation", "7",
    "--source-provider", "codex",
    "--actor-id-hash", "sha256:control",
  ];
}

test("parallel CLI execute accepts only a validated group document and explicit CONTROL identity", async () => {
  const module = await loadParallelCli();
  assert.equal(typeof module?.runParallelCli, "function", "runParallelCli must exist");

  await withGroupFile(group(), async (groupPath) => {
    const stdout = sink();
    const stderr = sink();
    let observed = null;
    const executors = [{ provider: "codex" }, { provider: "antigravity" }];
    const exitCode = await module.runParallelCli({
      argv: [
        "execute",
        "--group-file", groupPath,
        "--repo-root", join(tmpdir(), "orchestra-parallel-cli-repo"),
        "--source-provider", "codex",
        "--actor-id-hash", "sha256:control",
      ],
      stdout,
      stderr,
      executors,
      executeGroup: async (facts) => {
        observed = facts;
        return { status: "READY_FOR_REVIEW", groupId: "parallel-group-1", compositeArtifact: "composite-1" };
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.text(), "");
    assert.deepEqual(observed, {
      repoRoot: resolve(join(tmpdir(), "orchestra-parallel-cli-repo")),
      group: group(),
      actor: {
        provider: "codex",
        actorIdHash: "sha256:control",
        actorKind: "ROOT",
        isRoot: true,
      },
      executors,
    });
    assert.equal(JSON.parse(stdout.text()).groupId, "parallel-group-1");
  });
});

test("parallel CLI cannot execute an ordinary delegation request as a same-provider escape hatch", async () => {
  const module = await loadParallelCli();
  assert.equal(typeof module?.runParallelCli, "function", "runParallelCli must exist");

  const forged = {
    schema: "orchestra.delegation-request.v2",
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "codex", logicalRole: "IMPLEMENTER" },
  };
  await withGroupFile(forged, async (groupPath) => {
    let called = false;
    const stdout = sink();
    const stderr = sink();
    const exitCode = await module.runParallelCli({
      argv: [
        "execute",
        "--group-file", groupPath,
        "--repo-root", "/repo",
        "--source-provider", "codex",
        "--actor-id-hash", "sha256:control",
      ],
      stdout,
      stderr,
      executeGroup: async () => { called = true; },
      executors: [{ provider: "codex" }, { provider: "antigravity" }],
    });
    assert.equal(exitCode, 2);
    assert.equal(called, false);
    assert.equal(stdout.text(), "");
    assert.equal(stderr.text(), "ORCHESTRA_PARALLEL_CLI_USAGE_INVALID\n");
  });
});

test("parallel CLI inspect delegates without synthesizing mutation authority", async () => {
  const module = await loadParallelCli();
  assert.equal(typeof module?.runParallelCli, "function", "runParallelCli must exist");
  let observed = null;
  const stdout = sink();
  const stderr = sink();
  const exitCode = await module.runParallelCli({
    argv: ["inspect", "--artifact", "composite-1", "--repo-root", "/repo"],
    stdout,
    stderr,
    inspectArtifact: async (facts) => {
      observed = facts;
      return { manifest: { artifactId: "composite-1", state: "READY_FOR_REVIEW" } };
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  assert.deepEqual(observed, { repoRoot: resolve("/repo"), artifactId: "composite-1" });
});

test("parallel CLI promote and discard pass only explicit root CONTROL identity", async () => {
  const module = await loadParallelCli();
  assert.equal(typeof module?.runParallelCli, "function", "runParallelCli must exist");

  for (const action of ["promote", "discard"]) {
    let observed = null;
    const stdout = sink();
    const stderr = sink();
    const handler = async (facts) => {
      observed = facts;
      return action === "promote"
        ? { promoted: true, reason: null, changedPaths: ["src/home/a.mjs"] }
        : { discarded: true, reason: null };
    };
    const exitCode = await module.runParallelCli({
      argv: mutationArgs(action),
      stdout,
      stderr,
      ...(action === "promote" ? { promoteArtifact: handler } : { discardArtifact: handler }),
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr.text(), "");
    assert.deepEqual(observed, {
      repoRoot: resolve(join(tmpdir(), "orchestra-parallel-cli-repo")),
      artifactId: "composite-1",
      generation: 7,
      actor: {
        provider: "codex",
        actorIdHash: "sha256:control",
        actorKind: "ROOT",
        isRoot: true,
      },
    });
  }
});

test("parallel CLI rejects unsafe IDs, malformed flags, invalid group JSON, and implicit authority", async () => {
  const module = await loadParallelCli();
  assert.equal(typeof module?.runParallelCli, "function", "runParallelCli must exist");

  const cases = [
    ["inspect", "--artifact", "../escape", "--repo-root", "/repo"],
    ["promote", "--artifact", "composite-1", "--repo-root", "/repo", "--generation", "7", "--source-provider", "codex"],
    ["discard", "--artifact", "composite-1", "--repo-root", "/repo", "--generation", "-1", "--source-provider", "codex", "--actor-id-hash", "sha256:control"],
    ["unknown", "--artifact", "composite-1", "--repo-root", "/repo"],
  ];
  for (const argv of cases) {
    const stdout = sink();
    const stderr = sink();
    const exitCode = await module.runParallelCli({ argv, stdout, stderr });
    assert.equal(exitCode, 2, argv.join(" "));
    assert.equal(stdout.text(), "");
    assert.equal(stderr.text(), "ORCHESTRA_PARALLEL_CLI_USAGE_INVALID\n");
  }

  const dir = mkdtempSync(join(tmpdir(), "orchestra-parallel-cli-invalid-"));
  const invalid = join(dir, "group.json");
  writeFileSync(invalid, "{not-json", "utf8");
  try {
    const stdout = sink();
    const stderr = sink();
    const exitCode = await module.runParallelCli({
      argv: ["execute", "--group-file", invalid, "--repo-root", "/repo", "--source-provider", "codex", "--actor-id-hash", "sha256:control"],
      stdout,
      stderr,
    });
    assert.equal(exitCode, 2);
    assert.equal(stderr.text(), "ORCHESTRA_PARALLEL_CLI_USAGE_INVALID\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel CLI denies every action from delegated worker context", async () => {
  const module = await loadParallelCli();
  assert.equal(typeof module?.runParallelCli, "function", "runParallelCli must exist");

  for (const env of [
    { ORCHESTRA_DELEGATION_ACTIVE: "1" },
    { ORCHESTRA_DELEGATION_DEPTH: "1" },
  ]) {
    let called = false;
    const stdout = sink();
    const stderr = sink();
    const exitCode = await module.runParallelCli({
      argv: mutationArgs("promote"),
      stdout,
      stderr,
      env,
      promoteArtifact: async () => { called = true; },
    });
    assert.equal(exitCode, 2);
    assert.equal(called, false);
    assert.equal(stdout.text(), "");
    assert.equal(stderr.text(), "ORCHESTRA_PARALLEL_CLI_RECURSION_DENIED\n");
  }
});

test("parallel CLI maps internal exceptions to bounded execution failure", async () => {
  const module = await loadParallelCli();
  assert.equal(typeof module?.runParallelCli, "function", "runParallelCli must exist");
  const stdout = sink();
  const stderr = sink();
  const exitCode = await module.runParallelCli({
    argv: mutationArgs("promote"),
    stdout,
    stderr,
    promoteArtifact: async () => { throw new Error("sensitive internal detail"); },
  });
  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "ORCHESTRA_PARALLEL_CLI_EXECUTION_FAILED\n");
});
