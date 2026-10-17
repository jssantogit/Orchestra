import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReferenceState } from "../../v2/state/reference-state.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { defineStateConformanceSuite } from "./helpers/state-conformance.mjs";

defineStateConformanceSuite(test, {
  name: "reference store",
  async create() {
    return { state: createReferenceState(), cleanup: async () => {} };
  },
});

defineStateConformanceSuite(test, {
  name: "sqlite store",
  async create() {
    const root = await mkdtemp(join(tmpdir(), "orchestra-v2-conformance-"));
    const state = createSqliteState({ dbPath: join(root, "orchestra.db") });
    return {
      state,
      async cleanup() {
        state.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  },
});
