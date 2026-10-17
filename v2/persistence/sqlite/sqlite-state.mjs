import { createInMemoryRecoveryJournal } from "../../reconciliation/recovery-journal.mjs";
import { fenceOperationsToActiveWork } from "../../state/active-work-operation-fence.mjs";
import { createSqliteRecoveryJournal } from "./sqlite-recovery-journal.mjs";
import { createSqliteState as createSqliteStateCore } from "./sqlite-state-core.mjs";

export function createSqliteState(options = {}) {
  const core = fenceOperationsToActiveWork(createSqliteStateCore(options));
  let recoveries;
  try {
    recoveries = options.dbPath === ":memory:"
      ? createInMemoryRecoveryJournal({ state: core })
      : createSqliteRecoveryJournal({
        dbPath: options.dbPath,
        state: core,
        timeoutMs: options.timeoutMs,
      });
  } catch (error) {
    core.close();
    throw error;
  }

  let closed = false;
  return Object.freeze({
    ...core,
    recoveries,
    close() {
      if (closed) return;
      recoveries.close?.();
      core.close();
      closed = true;
    },
  });
}
