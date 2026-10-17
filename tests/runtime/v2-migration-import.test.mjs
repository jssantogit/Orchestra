import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createLegacyMigrationImporter } from "../../v2/migration/import.mjs";
import { classifyLegacyInventoryEntry } from "../../v2/migration/transient-classifier.mjs";

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function versionFromSchema(schema) {
  const match = typeof schema === "string" ? schema.match(/\.v([1-9][0-9]*)$/) : null;
  return match ? Number(match[1]) : null;
}

function inventoryEntry(path, bytes, overrides = {}) {
  const record = JSON.parse(bytes.toString("utf8"));
  return {
    path,
    category: "DURABLE_LEGACY_STATE",
    schema: record.schema,
    version: versionFromSchema(record.schema),
    digest: digest(bytes),
    integrity: "PARSED",
    dispositionBasis: "DURABLE_STATE",
    private: false,
    ...overrides,
  };
}

function fixtures() {
  const candidateBytes = jsonBytes({
    schema: "orchestra.candidate.v1",
    taskId: "task-legacy-1",
    candidateId: "candidate-legacy-1",
    generation: 3,
    workspaceId: "legacy-workspace",
    headSha: "0123456789abcdef",
  });
  const evidenceBytes = jsonBytes({
    schema: "orchestra.evidence.v1",
    taskId: "task-legacy-1",
    candidateId: "candidate-legacy-1",
    candidateGeneration: 3,
    kind: "TEST",
    status: "PASS",
    source: { provider: "codex", reference: "legacy-run-1" },
  });
  const continuationBytes = jsonBytes({
    schema: "orchestra.work-continuation.v1",
    task: { taskId: "task-legacy-1", state: "DONE", action: null, domain: "code", implementationDirection: null },
    workspaceId: "legacy-workspace",
    workspaceFingerprint: "legacy-fingerprint",
    leaseGeneration: 9,
    candidate: {
      taskId: "task-legacy-1",
      candidateId: "candidate-legacy-1",
      generation: 3,
      workspaceId: "legacy-workspace",
      headSha: "0123456789abcdef",
    },
    evidence: [],
    audit: null,
    blockers: [],
  });
  const privateBytes = jsonBytes({
    schema: "orchestra.delegation-artifact.v1",
    prompt: "private legacy prompt",
    source: "private source bytes",
  });

  const candidate = inventoryEntry(".orchestra/state/candidates/task-legacy-1/candidate.json", candidateBytes);
  const evidence = inventoryEntry(".orchestra/state/evidence/task-legacy-1/test.json", evidenceBytes);
  const continuation = inventoryEntry(".orchestra/state/continuation/task-legacy-1.json", continuationBytes);
  const archive = inventoryEntry(
    ".orchestra/state/delegation/artifacts/artifact-1/result.json",
    privateBytes,
    {
      category: "PRIVATE_PROJECT_ARTIFACT",
      dispositionBasis: "PRIVATE_ARCHIVE",
      private: true,
    },
  );

  const cleanFacts = { provenanceComplete: true, unresolvedTransientAuthority: false };
  return {
    entries: [candidate, evidence, continuation, archive],
    classifications: [candidate, evidence, continuation].map((entry) => ({
      path: entry.path,
      result: classifyLegacyInventoryEntry({ entry, facts: cleanFacts }),
    })).concat([{
      path: archive.path,
      result: classifyLegacyInventoryEntry({ entry: archive }),
    }]),
    durableFacts: {
      candidate: { path: candidate.path, bytes: candidateBytes, provenanceComplete: true },
      evidence: [{ path: evidence.path, bytes: evidenceBytes, provenanceComplete: true }],
      continuation: { path: continuation.path, bytes: continuationBytes, provenanceComplete: true },
    },
    privateArchives: [{ path: archive.path, bytes: privateBytes }],
  };
}

function createFakeRegistry({ failWorkOpen = false } = {}) {
  const projectsByRoot = new Map();
  const workById = new Map();
  const blobs = new Map();
  const events = [];
  let experienceWrites = 0;

  return {
    events,
    get experienceWrites() { return experienceWrites; },
    async registerWorkspace({ root, runtimeImage, instructionEpoch, trustMode }) {
      events.push(`register:${root}`);
      const existing = projectsByRoot.get(root);
      if (existing) return { ok: true, project: existing, replayed: true };
      const index = projectsByRoot.size + 1;
      const project = {
        schema: "orchestra.project.v2",
        projectId: `prj_fake_${index}`,
        lineageId: `lineage_fake_${index}`,
        workspace: { canonicalRoot: root, vcs: "git" },
        runtime: { pinnedImage: runtimeImage, instructionEpoch },
        trust: { mode: trustMode },
      };
      projectsByRoot.set(root, project);
      return { ok: true, project, replayed: false };
    },
    state: {
      work: {
        open(work) {
          events.push(`work:${work.workId}`);
          if (failWorkOpen) return { ok: false, reason: "INJECTED_WORK_FAILURE" };
          const existing = workById.get(work.workId);
          if (existing) {
            if (JSON.stringify(existing) === JSON.stringify(work)) return { ok: true, work: existing, replayed: true };
            return { ok: false, reason: "WORK_ID_CONFLICT" };
          }
          workById.set(work.workId, structuredClone(work));
          return { ok: true, work: structuredClone(work), replayed: false };
        },
        current() { return null; },
        read(projectId, workId) {
          const work = workById.get(workId) ?? null;
          return work?.projectId === projectId ? structuredClone(work) : null;
        },
      },
      experience: {
        put() {
          experienceWrites += 1;
          throw new Error("Experience must not be written by migration import");
        },
      },
    },
    blobs: {
      async putBytes(bytes) {
        const key = digest(bytes);
        events.push(`blob:${key}`);
        const replayed = blobs.has(key);
        blobs.set(key, Buffer.from(bytes));
        return { digest: key, size: bytes.length, replayed, path: `/fake/${key}` };
      },
      async verify(key) {
        return blobs.has(key) ? { valid: true, digest: key, size: blobs.get(key).length } : { valid: false, reason: "BLOB_NOT_FOUND", digest: key };
      },
    },
    inspectWork(workId) { return workById.get(workId) ?? null; },
  };
}

function applyInput(workspace, overrides = {}) {
  const data = fixtures();
  return {
    workspace,
    commandId: "migration-command-1",
    runtimeImage: "runtime-image-migration",
    instructionEpoch: 7,
    trustMode: "trusted",
    inventory: data.entries,
    classifications: data.classifications,
    durableFacts: data.durableFacts,
    privateArchives: data.privateArchives,
    legacyMetadata: { sessionId: "legacy-session-must-not-be-authority" },
    ...overrides,
  };
}

test("durable import registers exactly one Project before sealing/importing project-scoped facts", async () => {
  const registry = createFakeRegistry();
  const importer = createLegacyMigrationImporter({ projectRegistry: registry });
  const result = await importer.apply(applyInput("/workspace/a"));

  assert.equal(result.ok, true);
  assert.equal(result.code, "MIGRATION_DURABLE_IMPORT_APPLIED");
  assert.equal(registry.events[0], "register:/workspace/a");
  assert.equal(registry.events.filter((event) => event.startsWith("register:")).length, 1);
  assert.ok(registry.events.some((event) => event.startsWith("blob:")));
  assert.ok(registry.events.some((event) => event.startsWith("work:")));
  assert.equal(result.work.projectId, result.project.projectId);
  assert.equal(result.work.generation, 0);
  assert.equal("sessionId" in result.work, false);
  assert.equal("actor" in result.work, false);
});

test("candidate/evidence/continuation require exact inventory digest, schema and provenance before import", async () => {
  const data = fixtures();
  const registry = createFakeRegistry();
  const importer = createLegacyMigrationImporter({ projectRegistry: registry });

  const tamperedCandidate = {
    ...data.durableFacts.candidate,
    bytes: jsonBytes({ schema: "orchestra.candidate.v1", taskId: "tampered" }),
  };
  const digestFailure = await importer.apply(applyInput("/workspace/digest", {
    durableFacts: { ...data.durableFacts, candidate: tamperedCandidate },
  }));
  assert.equal(digestFailure.ok, false);
  assert.equal(digestFailure.code, "MIGRATION_FACT_DIGEST_MISMATCH");

  const schemaMismatchBytes = jsonBytes({ schema: "orchestra.evidence.v1", taskId: "task-legacy-1" });
  const schemaFailure = await importer.apply(applyInput("/workspace/schema", {
    durableFacts: {
      ...data.durableFacts,
      candidate: { ...data.durableFacts.candidate, bytes: schemaMismatchBytes },
    },
  }));
  assert.equal(schemaFailure.ok, false);
  assert.equal(schemaFailure.code, "MIGRATION_FACT_DIGEST_MISMATCH");

  const provenanceFailure = await importer.apply(applyInput("/workspace/provenance", {
    durableFacts: {
      ...data.durableFacts,
      continuation: { ...data.durableFacts.continuation, provenanceComplete: false },
    },
  }));
  assert.equal(provenanceFailure.ok, false);
  assert.equal(provenanceFailure.code, "MIGRATION_FACT_PROVENANCE_REQUIRED");
});

test("same command is idempotent across importer restart while project/work identity remains project-scoped", async () => {
  const registry = createFakeRegistry();
  const firstImporter = createLegacyMigrationImporter({ projectRegistry: registry });
  const first = await firstImporter.apply(applyInput("/workspace/a"));
  const secondImporter = createLegacyMigrationImporter({ projectRegistry: registry });
  const second = await secondImporter.apply(applyInput("/workspace/a"));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.project.projectId, first.project.projectId);
  assert.equal(second.work.workId, first.work.workId);

  const other = await secondImporter.apply(applyInput("/workspace/b"));
  assert.equal(other.ok, true);
  assert.notEqual(other.project.projectId, first.project.projectId);
  assert.notEqual(other.work.workId, first.work.workId);
});

test("work import failure leaves no active Work head and does not invent success", async () => {
  const registry = createFakeRegistry({ failWorkOpen: true });
  const importer = createLegacyMigrationImporter({ projectRegistry: registry });
  const result = await importer.apply(applyInput("/workspace/fail"));
  assert.equal(result.ok, false);
  assert.equal(result.code, "MIGRATION_WORK_IMPORT_FAILED");
  assert.equal(registry.state.work.current("prj_fake_1"), null);
  assert.equal(result.successClaim, false);
});

test("PRIVATE_ARCHIVE is sealed separately and never projected into Experience", async () => {
  const registry = createFakeRegistry();
  const importer = createLegacyMigrationImporter({ projectRegistry: registry });
  const result = await importer.apply(applyInput("/workspace/private"));
  assert.equal(result.ok, true);
  assert.equal(result.archives.length, 1);
  assert.match(result.archives[0].digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.archives[0].private, true);
  assert.equal(registry.experienceWrites, 0);
  assert.equal(result.work.evidenceRefs.includes(result.archives[0].digest), false);
});

test("UNSUPPORTED_BLOCKED prevents import activation while preserving inventory evidence", async () => {
  const data = fixtures();
  const blockedEntry = {
    ...data.entries[0],
    path: ".orchestra/state/candidates/broken.json",
    schema: "orchestra.candidate.v9",
    version: 9,
  };
  const registry = createFakeRegistry();
  const importer = createLegacyMigrationImporter({ projectRegistry: registry });
  const result = await importer.apply(applyInput("/workspace/blocked", {
    inventory: [...data.entries, blockedEntry],
    classifications: [...data.classifications, {
      path: blockedEntry.path,
      result: classifyLegacyInventoryEntry({
        entry: blockedEntry,
        facts: { provenanceComplete: true, unresolvedTransientAuthority: false },
      }),
    }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "MIGRATION_BLOCKED");
  assert.equal(registry.events.length, 0);
  assert.ok(result.inventoryEvidence.some((item) => item.path === blockedEntry.path && item.disposition === "UNSUPPORTED_BLOCKED"));
});

const nodeMajor = Number(process.versions.node.split(".")[0]);

test("same migration command replays after real SQLite registry close/reopen", { skip: nodeMajor < 22 }, async () => {
  const [{ mkdtemp, rm }, { join }, { tmpdir }, { execFileSync }, { createGlobalProjectRegistry }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("node:os"),
    import("node:child_process"),
    import("../../v2/global/project-registry.mjs"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-migration-import-"));
  const workspace = join(root, "project");
  const home = join(root, "home");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace, { recursive: true }));
    execFileSync("git", ["init", workspace], { stdio: "ignore" });

    let registry = createGlobalProjectRegistry({ home });
    let importer = createLegacyMigrationImporter({ projectRegistry: registry });
    const first = await importer.apply(applyInput(workspace));
    assert.equal(first.ok, true);
    registry.close();

    registry = createGlobalProjectRegistry({ home });
    importer = createLegacyMigrationImporter({ projectRegistry: registry });
    const second = await importer.apply(applyInput(workspace));
    assert.equal(second.ok, true);
    assert.equal(second.replayed, true);
    assert.equal(second.project.projectId, first.project.projectId);
    assert.equal(second.work.workId, first.work.workId);
    assert.equal(registry.state.work.current(first.project.projectId), null);
    registry.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
