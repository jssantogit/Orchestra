import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateOperationV2,
  validateProjectV2,
  validateWorkUnitV2,
} from "../../v2/domain/contracts.mjs";
import {
  createContinuationCapsule,
  verifyContinuationCapsule,
} from "../../v2/continuation/capsule.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const project = {
  schema: "orchestra.project.v2",
  projectId: "prj-continuation",
  lineageId: "lineage-continuation",
  workspace: { canonicalRoot: "C:/Projects/Continuation", vcs: "git" },
  runtime: { pinnedImage: "2.0.0", instructionEpoch: 7 },
  trust: { mode: "trusted" },
};

const work = {
  schema: "orchestra.work-unit.v2",
  workId: "work-continuation",
  projectId: project.projectId,
  taskId: "task-continuation",
  generation: 4,
  runtimeImage: "2.0.0",
  instructionEpoch: 7,
  state: "IMPLEMENTING",
  scopeRef: "scope:4",
  directionRef: "direction:4",
  candidateRef: "candidate:4",
  evidenceRefs: ["evidence:1"],
  blockers: [],
  continuationRef: "continuation:4",
};

const operation = {
  schema: "orchestra.operation.v2",
  operationId: "op-continuation",
  projectId: project.projectId,
  workId: work.workId,
  generation: work.generation,
  kind: "DIRECT_MUTATION",
  actorRef: "actor:fact",
  capabilities: ["WORKSPACE_EDIT"],
  workflowState: "RUNNING",
  liveness: "LIVE",
  startedAt: "2026-10-16T22:00:00.000Z",
  heartbeatAt: "2026-10-16T22:00:00.000Z",
  deadlineAt: "2026-10-16T22:10:00.000Z",
  runtimeOwnerRef: "process:1:token",
  workspaceRef: "workspace:canonical",
  resultRef: null,
};

async function walkMjs(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkMjs(absolute));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(absolute);
  }
  return files;
}

function repositoryRelativePath(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function providerFamily(path) {
  const match = /^v2\/providers\/(codex|antigravity)(?:\/|$)/.exec(path);
  return match?.[1] ?? null;
}

function importBoundaryViolation(sourcePath, specifier) {
  if (!specifier.startsWith(".")) {
    if (specifier.startsWith("node:")) return null;

    const normalizedSpecifier = specifier.replaceAll("\\", "/");
    if (["/providers/", "/runtimes/", "/core/", ".codex", ".agents"].some((token) => normalizedSpecifier.includes(token))) {
      return "legacy-runtime-boundary";
    }
    return null;
  }

  const sourceFile = join(repoRoot, sourcePath);
  const destinationPath = resolve(dirname(sourceFile), specifier);
  const destinationRelativePath = repositoryRelativePath(destinationPath);
  const segments = destinationRelativePath.split("/");

  if (destinationRelativePath === ".." || destinationRelativePath.startsWith("../")) {
    return "outside-repository";
  }
  if (["providers", "runtimes", "core"].includes(segments[0])) {
    return "legacy-runtime-boundary";
  }
  if (segments.includes(".codex") || segments.includes(".agents")) {
    return "project-local-integration-tree";
  }

  const destinationFamily = providerFamily(destinationRelativePath);
  if (destinationFamily) {
    const sourceFamily = providerFamily(sourcePath);
    if (sourceFamily === destinationFamily || sourcePath === "v2/global/cli.mjs") return null;
    return "provider-family-boundary";
  }

  return null;
}

test("durable v2 authority contracts reject hidden session ownership fields", () => {
  assert.equal(validateProjectV2({ ...project, ownerSessionId: "chat-a" }).valid, false);
  assert.equal(validateWorkUnitV2({ ...work, conversationId: "chat-a" }).valid, false);
  assert.equal(validateOperationV2({ ...operation, sessionId: "chat-a" }).valid, false);
});

test("continuation capsule is transcript-free, versioned and reproducible", () => {
  const result = createContinuationCapsule({
    work,
    facts: {
      taskSummary: "Continue F7 from the accepted decomposition.",
      decisions: { implementationMode: "PARALLEL_2", shards: ["home", "library"] },
      nextActions: ["inspect current operations", "continue compatible work"],
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.capsule.projectId, work.projectId);
  assert.equal(result.capsule.workId, work.workId);
  assert.equal(result.capsule.generation, 4);
  assert.equal(result.capsule.digest.algorithm, "sha256");
  assert.equal(result.capsule.digest.canonicalization, "orchestra.canonical-json.v1");
  assert.match(result.capsule.digest.value, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verifyContinuationCapsule(result.capsule).valid, true);
});

test("continuation digest is independent of object key insertion order", () => {
  const a = createContinuationCapsule({ work, facts: { alpha: 1, nested: { x: 1, y: 2 } } });
  const b = createContinuationCapsule({ work, facts: { nested: { y: 2, x: 1 }, alpha: 1 } });

  assert.equal(a.valid, true);
  assert.equal(b.valid, true);
  assert.equal(a.capsule.digest.value, b.capsule.digest.value);
});

test("continuation rejects transcript, prompt and hidden-reasoning dependencies", () => {
  for (const facts of [
    { transcript: "old chat" },
    { nested: { chatHistory: ["old", "messages"] } },
    { prompt: "session bootstrap" },
    { hiddenReasoning: "private reasoning" },
    { chainOfThought: "private reasoning" },
    { sessionId: "raw-session" },
  ]) {
    const result = createContinuationCapsule({ work, facts });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "CONTINUATION_CHAT_DEPENDENCY");
  }
});

test("continuation verification detects mutation after sealing", () => {
  const created = createContinuationCapsule({ work, facts: { taskSummary: "bounded fact" } });
  assert.equal(created.valid, true);

  const tampered = structuredClone(created.capsule);
  tampered.facts.taskSummary = "changed after sealing";

  const verification = verifyContinuationCapsule(tampered);
  assert.equal(verification.valid, false);
  assert.equal(verification.reason, "CONTINUATION_DIGEST_MISMATCH");
});

test("v2 imports preserve legacy, neutral-core and provider-family boundaries", async () => {
  assert.equal(
    importBoundaryViolation("v2/global/cli.mjs", "../../providers/codex/adapter/session.mjs"),
    "legacy-runtime-boundary",
  );
  assert.equal(
    importBoundaryViolation("v2/liveness/operation-liveness-service.mjs", "../providers/codex/hook-handler.mjs"),
    "provider-family-boundary",
  );
  assert.equal(
    importBoundaryViolation("v2/providers/codex/hook-handler.mjs", "../antigravity/hook-handler.mjs"),
    "provider-family-boundary",
  );
  assert.equal(importBoundaryViolation("v2/global/cli.mjs", "../providers/codex/hook-handler.mjs"), null);
  assert.equal(
    importBoundaryViolation("v2/persistence/sqlite/sqlite-state-core.mjs", "../../providers/session-observation-store.mjs"),
    null,
  );
  assert.equal(
    importBoundaryViolation("v2/global/cli.mjs", "file:///C:/Orchestra/providers/codex/adapter.mjs"),
    "legacy-runtime-boundary",
  );
  assert.equal(
    importBoundaryViolation("v2/global/cli.mjs", "@orchestra/runtime/runtimes/codex-hook"),
    "legacy-runtime-boundary",
  );
  assert.equal(importBoundaryViolation("v2/global/cli.mjs", "node:sqlite"), null);

  const files = await walkMjs(join(repoRoot, "v2"));

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)].map((match) => match[1]);
    const sourcePath = repositoryRelativePath(file);
    for (const specifier of specifiers) {
      const violation = importBoundaryViolation(sourcePath, specifier);
      assert.equal(violation, null, `${file} imports forbidden ${violation} boundary ${specifier}`);
    }
  }
});

test("global v2 core is absent from both materialized provider runtime mirrors", async () => {
  const forbiddenMirrors = [
    join(repoRoot, "runtimes/codex/.codex/astra-orchestra/core/v2"),
    join(repoRoot, "runtimes/antigravity/.agents/skills/orchestra/core/v2"),
  ];

  for (const path of forbiddenMirrors) {
    await assert.rejects(access(path));
  }
});
