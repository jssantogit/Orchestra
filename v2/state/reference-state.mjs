import { createInMemoryRecoveryJournal } from "../reconciliation/recovery-journal.mjs";
import { fenceOperationsToActiveWork } from "./active-work-operation-fence.mjs";
import { createReferenceState as createReferenceStateCore } from "./reference-state-core.mjs";

export function createReferenceState() {
  const state = fenceOperationsToActiveWork(createReferenceStateCore());
  const recoveries = createInMemoryRecoveryJournal({ state });
  return Object.freeze({ ...state, recoveries });
}
