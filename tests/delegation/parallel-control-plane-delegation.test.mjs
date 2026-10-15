import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodexParallelImplementationGroup,
  discardCodexCompositeArtifact,
  executeCodexParallelImplementation,
  inspectCodexCompositeArtifact,
  promoteCodexCompositeArtifact,
} from "../../runtimes/codex/.codex/astra-orchestra/cross-provider-delegation.mjs";
import {
  buildAntigravityParallelImplementationGroup,
  discardAntigravityCompositeArtifact,
  executeAntigravityParallelImplementation,
  inspectAntigravityCompositeArtifact,
  promoteAntigravityCompositeArtifact,
} from "../../runtimes/antigravity/.agents/skills/orchestra/cross-provider-delegation.mjs";
import { validateParallelImplementationGroup } from "../../core/domain/parallel-implementation.mjs";

function packet(taskId = "parallel-task", generation = 7, file = "src/example.mjs") {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId,
    candidateGeneration: generation,
    goal: `implement ${file}`,
    direction: { change: `change ${file}`, preserve: ["other shard"] },
    anchors: [{ file }],
    scope: { allowedAreas: ["src/**"], forbidden: [] },
    permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: [] },
    validation: ["focused tests"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function members(localProvider, externalProvider) {
  return [
    {
      memberId: "local",
      targetProvider: localProvider,
      packet: packet("parallel-task", 7, "src/home/a.mjs"),
      mutationScope: { allowedPaths: ["src/home/**"], forbiddenPaths: [] },
    },
    {
      memberId: "external",
      targetProvider: externalProvider,
      packet: packet("parallel-task", 7, "src/library/a.mjs"),
      mutationScope: { allowedPaths: ["src/library/**"], forbiddenPaths: [] },
    },
  ];
}

function buildFacts() {
  return {
    groupId: "parallel-group-1",
    actorIdHash: "sha256:control",
    generation: 7,
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
  };
}

test("Codex and Antigravity build the same neutral parallel group shape with provider-local source identity", () => {
  const codex = buildCodexParallelImplementationGroup({
    ...buildFacts(),
    members: members("codex", "antigravity"),
  });
  const antigravity = buildAntigravityParallelImplementationGroup({
    ...buildFacts(),
    members: members("antigravity", "codex"),
  });

  assert.equal(validateParallelImplementationGroup(codex).valid, true);
  assert.equal(validateParallelImplementationGroup(antigravity).valid, true);
  assert.equal(codex.schema, "orchestra.parallel-implementation-group.v1");
  assert.equal(antigravity.schema, codex.schema);
  assert.deepEqual(codex.source, { provider: "codex", actorIdHash: "sha256:control" });
  assert.deepEqual(antigravity.source, { provider: "antigravity", actorIdHash: "sha256:control" });
  assert.deepEqual(codex.members.map((entry) => entry.targetProvider), ["codex", "antigravity"]);
  assert.deepEqual(antigravity.members.map((entry) => entry.targetProvider), ["antigravity", "codex"]);
});

test("parallel group builders require one provider-local member and one distinct external member", () => {
  assert.throws(() => buildCodexParallelImplementationGroup({
    ...buildFacts(),
    members: members("antigravity", "other"),
  }), /ORCHESTRA_CODEX_PARALLEL_GROUP_INVALID/);
  assert.throws(() => buildAntigravityParallelImplementationGroup({
    ...buildFacts(),
    members: members("codex", "other"),
  }), /ORCHESTRA_ANTIGRAVITY_PARALLEL_GROUP_INVALID/);
});

test("Codex and Antigravity execute parallel groups through the neutral parallel CLI without self-acceptance", async () => {
  const cases = [
    {
      source: "codex",
      group: buildCodexParallelImplementationGroup({ ...buildFacts(), members: members("codex", "antigravity") }),
      execute: executeCodexParallelImplementation,
    },
    {
      source: "antigravity",
      group: buildAntigravityParallelImplementationGroup({ ...buildFacts(), members: members("antigravity", "codex") }),
      execute: executeAntigravityParallelImplementation,
    },
  ];

  for (const entry of cases) {
    let observed = null;
    const result = await entry.execute({
      group: entry.group,
      repoRoot: "/repo",
      runParallelCli: async (facts) => {
        observed = facts;
        return { status: "READY_FOR_REVIEW", groupId: entry.group.groupId, compositeArtifact: "composite-1" };
      },
    });
    assert.deepEqual(observed, {
      action: "execute",
      group: entry.group,
      repoRoot: "/repo",
      sourceProvider: entry.source,
      actorIdHash: "sha256:control",
    });
    assert.equal(result.controlReturned, true);
    assert.equal(result.accepted, false);
    assert.equal(result.claimOnly, true);
    assert.equal(result.result.compositeArtifact, "composite-1");
  }
});

test("provider parallel execution returns explicit failure and never falls back to serial/manual work", async () => {
  const group = buildCodexParallelImplementationGroup({ ...buildFacts(), members: members("codex", "antigravity") });
  const outcome = await executeCodexParallelImplementation({
    group,
    repoRoot: "/repo",
    runParallelCli: async () => ({ status: "FAILED", reason: "PROVIDER_UNAVAILABLE", groupId: group.groupId }),
  });
  assert.equal(outcome.controlReturned, true);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.result.status, "FAILED");
  assert.equal(outcome.result.reason, "PROVIDER_UNAVAILABLE");
  assert.equal("fallback" in outcome, false);
});

test("provider composite wrappers invoke the neutral parallel lifecycle with exact CONTROL provenance", async () => {
  const cases = [
    {
      source: "codex",
      inspect: inspectCodexCompositeArtifact,
      promote: promoteCodexCompositeArtifact,
      discard: discardCodexCompositeArtifact,
    },
    {
      source: "antigravity",
      inspect: inspectAntigravityCompositeArtifact,
      promote: promoteAntigravityCompositeArtifact,
      discard: discardAntigravityCompositeArtifact,
    },
  ];

  for (const entry of cases) {
    const observed = [];
    const runParallelCli = async (facts) => {
      observed.push(facts);
      if (facts.action === "inspect") return { integrity: { valid: true }, reviewPath: "/tmp/review" };
      if (facts.action === "promote") return { promoted: true, reason: null, changedPaths: ["src/home/a.mjs"] };
      return { discarded: true, reason: null };
    };

    await entry.inspect({ repoRoot: "/repo", artifactId: "composite-1", runParallelCli });
    await entry.promote({ repoRoot: "/repo", artifactId: "composite-1", generation: 7, actorIdHash: "sha256:control", runParallelCli });
    await entry.discard({ repoRoot: "/repo", artifactId: "composite-2", generation: 7, actorIdHash: "sha256:control", runParallelCli });

    assert.deepEqual(observed, [
      { action: "inspect", repoRoot: "/repo", artifactId: "composite-1" },
      {
        action: "promote",
        repoRoot: "/repo",
        artifactId: "composite-1",
        generation: 7,
        sourceProvider: entry.source,
        actorIdHash: "sha256:control",
      },
      {
        action: "discard",
        repoRoot: "/repo",
        artifactId: "composite-2",
        generation: 7,
        sourceProvider: entry.source,
        actorIdHash: "sha256:control",
      },
    ]);
  }
});
