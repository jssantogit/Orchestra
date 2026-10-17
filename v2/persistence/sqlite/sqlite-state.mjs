import { createInMemoryRecoveryJournal } from "../../reconciliation/recovery-journal.mjs";
import { fenceOperationsToActiveWork } from "../../state/active-work-operation-fence.mjs";
import { trackOperationListing } from "../../state/operation-listing.mjs";
import { createSqliteExperiencePersistence } from "./sqlite-experience.mjs";
import { fenceSqliteOperationTerminalization } from "./sqlite-operation-terminalization-fence.mjs";
import { withSqliteProjectRuntimeUpdates } from "./sqlite-project-runtime.mjs";
import { createSqliteRecoveryJournal } from "./sqlite-recovery-journal.mjs";
import { createSqliteState as createSqliteStateCore } from "./sqlite-state-core.mjs";

export { createSqliteRuntimeImageRegistry } from "./sqlite-runtime-images.mjs";

export function createSqliteState(options = {}) {
  const listed = trackOperationListing(createSqliteStateCore(options));
  const runtimeMutable = withSqliteProjectRuntimeUpdates(listed, {
    dbPath: options.dbPath,
    timeoutMs: options.timeoutMs,
  });
  const activeWorkFenced = fenceOperationsToActiveWork(runtimeMutable);
  const core = fenceSqliteOperationTerminalization(activeWorkFenced, {
    dbPath: options.dbPath,
    timeoutMs: options.timeoutMs,
  });
  let recoveries;
  let experience;
  try {
    recoveries = options.dbPath === ":memory:"
      ? createInMemoryRecoveryJournal({ state: core })
      : createSqliteRecoveryJournal({
        dbPath: options.dbPath,
        state: core,
        timeoutMs: options.timeoutMs,
      });
    experience = createSqliteExperiencePersistence({
      dbPath: options.dbPath,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    recoveries?.close?.();
    core.close();
    throw error;
  }

  let closed = false;
  return Object.freeze({
    ...core,
    recoveries,
    experience,
    close() {
      if (closed) return;
      experience.close?.();
      recoveries.close?.();
      core.close();
      closed = true;
    },
  });
}
