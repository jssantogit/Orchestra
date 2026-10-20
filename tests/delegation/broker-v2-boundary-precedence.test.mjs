import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { createDelegationBroker } from '../helpers/resource-governor.mjs';

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-broker-v2-boundary-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

function requestFor(repoRoot) {
  const identity = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: "broker-v2-boundary-precedence",
    taskId: "broker-v2-boundary-precedence-task",
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: "broker-v2-boundary-precedence-task",
      candidateGeneration: 11,
      goal: "implement only inside the delegated clone",
      direction: { change: "edit tracked.txt", preserve: ["canonical checkout"] },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt"], forbidden: [".orchestra/state/**"] },
      permissions: {
        discovery: "DIRECTED",
        tests: "MODIFY_AUTHORIZED_TARGETS",
        sideEffects: ["WORKSPACE_EDIT"],
      },
      validation: ["canonical checkout stays unchanged"],
      failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
    },
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: identity.fingerprint,
      sourceRevision: identity.head,
      isolation: "EPHEMERAL_CLONE",
      mutationScope: { allowedPaths: ["tracked.txt"], forbiddenPaths: [] },
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

function actor() {
  return {
    provider: "codex",
    actorIdHash: "sha256:control",
    actorKind: "ROOT",
    isRoot: true,
  };
}

test("canonical boundary violation outranks executor failure and never yields an artifact", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const broker = createDelegationBroker({
    executors: [{
      provider: "antigravity",
      async discover() {
        return {
          available: true,
          provider: "antigravity",
          version: "test",
          capabilities: { implementation: true },
        };
      },
      async execute() {
        writeFileSync(join(repoRoot, "tracked.txt"), "forbidden-canonical-write\n");
        return {
          ok: false,
          provider: "antigravity",
          reason: "EXECUTION_FAILED",
          execution: { exitCode: 1, durationMs: 1 },
        };
      },
    }],
  });

  const result = await broker.executeDelegation(requestFor(repoRoot), {
    repoRoot,
    generation: 11,
    actor: actor(),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "SCOPE_VIOLATION");
  assert.equal("artifact" in result, false);
  assert.equal(readFileSync(join(repoRoot, "tracked.txt"), "utf8"), "forbidden-canonical-write\n");
});

test("broker preflight fingerprint ignores parent global Git clean filters", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, ".gitattributes"), "tracked.txt filter=orchestra-poison\n");
  git(repoRoot, "add", ".gitattributes");
  git(repoRoot, "commit", "-m", "add filter attribute");

  const request = requestFor(repoRoot);
  writeFileSync(join(repoRoot, "tracked.txt"), "canonical changed after request\n");

  const scratch = mkdtempSync(join(tmpdir(), "orchestra-broker-parent-git-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const configPath = join(scratch, "global.gitconfig");
  const filterPath = join(scratch, "clean-filter.mjs");
  const markerPath = join(scratch, "filter-ran.txt");
  writeFileSync(filterPath, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.ORCHESTRA_TEST_FILTER_MARKER, "ran\\n");',
    "process.stdin.pipe(process.stdout);",
    "",
  ].join("\n"));
  git(
    scratch,
    "config",
    "--file",
    configPath,
    "filter.orchestra-poison.clean",
    `node "${filterPath.replaceAll("\\", "/")}"`,
  );

  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousMarker = process.env.ORCHESTRA_TEST_FILTER_MARKER;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  process.env.ORCHESTRA_TEST_FILTER_MARKER = markerPath;
  let result;
  try {
    result = await createDelegationBroker({ executors: [] }).executeDelegation(request, {
      repoRoot,
      generation: 11,
      actor: actor(),
    });
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousMarker === undefined) delete process.env.ORCHESTRA_TEST_FILTER_MARKER;
    else process.env.ORCHESTRA_TEST_FILTER_MARKER = previousMarker;
  }

  assert.equal(existsSync(markerPath), false);
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "WORKSPACE_PREP_FAILED");
});
