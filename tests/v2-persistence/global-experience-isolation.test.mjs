import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

const project = {
  schema: "orchestra.project.v2",
  projectId: "prj-authority-survives-experience-corruption",
  lineageId: "lineage-authority-survives-experience-corruption",
  workspace: { canonicalRoot: "/tmp/authority-survives-experience-corruption", vcs: "git" },
  runtime: { pinnedImage: "sha256:image", instructionEpoch: 1 },
  trust: { mode: "trusted" },
};

test("missing Experience table fails learning closed without blocking Project authority reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-experience-isolation-"));
  const dbPath = join(root, "state", "orchestra.db");
  try {
    const initial = createSqliteState({ dbPath });
    assert.equal(initial.projects.register(project).ok, true);
    initial.close();

    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE experience_records");
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
    db.close();

    const reopened = createSqliteState({ dbPath });
    assert.deepEqual(reopened.projects.inspect(project.projectId), project);
    assert.throws(
      () => reopened.experience.list(),
      (error) => error?.code === "ORCHESTRA_EXPERIENCE_STORE_UNAVAILABLE",
    );
    assert.deepEqual(reopened.projects.inspect(project.projectId), project);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
