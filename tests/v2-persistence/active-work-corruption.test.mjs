import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createWorkAuthority } from "../../v2/authority/work-authority.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

function project(projectId = "prj-a", root = "C:/Projects/A") {
  return {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot: root, vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work({ workId = "work-a", projectId = "prj-a", taskId = "task-a" } = {}) {
  return {
    schema: "orchestra.work-unit.v2",
    workId,
    projectId,
    taskId,
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 1,
    state: "INTAKE",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function actor() {
  return {
    schema: "orchestra.actor-provenance.v2",
    provider: "codex",
    subjectHash: "sha256:corruption-probe",
    source: "PROVIDER_FACT",
    observedAt: "2026-10-17T00:45:00.000Z",
  };
}

async function withDb(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-head-corruption-"));
  const dbPath = join(root, "state.db");
  try {
    await fn(dbPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("SQLite missing-work head is explicit corruption, never NO_ACTIVE_WORK", async () => {
  await withDb(async (dbPath) => {
    const seeded = createSqliteState({ dbPath });
    seeded.projects.register(project());
    seeded.work.startCurrent(work());
    seeded.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare("DELETE FROM work_units WHERE work_id = ?").run("work-a");
    raw.close();

    const state = createSqliteState({ dbPath });
    try {
      assert.throws(
        () => state.work.current("prj-a"),
        (error) => error?.code === "ORCHESTRA_ACTIVE_WORK_HEAD_CORRUPT"
          && error?.projectId === "prj-a"
          && error?.workId === "work-a",
      );

      const attach = createWorkAuthority({ state }).attach({
        projectId: "prj-a",
        actor: actor(),
        observedInstructionEpoch: 1,
      });
      assert.deepEqual(attach, { allowed: false, reason: "ACTIVE_WORK_CORRUPT" });

      const replacement = state.work.startCurrent(work({ workId: "work-b", taskId: "task-b" }));
      assert.equal(replacement.ok, false);
      assert.equal(replacement.reason, "ACTIVE_WORK_EXISTS");
      assert.equal(replacement.currentWorkId, "work-a");
    } finally {
      state.close();
    }
  });
});

test("SQLite cross-project head is explicit corruption", async () => {
  await withDb(async (dbPath) => {
    const seeded = createSqliteState({ dbPath });
    seeded.projects.register(project("prj-a", "C:/Projects/A"));
    seeded.projects.register(project("prj-b", "C:/Projects/B"));
    seeded.work.startCurrent(work({ workId: "work-a", projectId: "prj-a", taskId: "task-a" }));
    seeded.work.startCurrent(work({ workId: "work-b", projectId: "prj-b", taskId: "task-b" }));
    seeded.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare("DELETE FROM project_work_heads WHERE project_id = ?").run("prj-b");
    raw.prepare("UPDATE project_work_heads SET work_id = ? WHERE project_id = ?").run("work-b", "prj-a");
    raw.close();

    const state = createSqliteState({ dbPath });
    try {
      assert.throws(
        () => state.work.current("prj-a"),
        (error) => error?.code === "ORCHESTRA_ACTIVE_WORK_HEAD_CORRUPT"
          && error?.projectId === "prj-a"
          && error?.workId === "work-b",
      );
    } finally {
      state.close();
    }
  });
});
