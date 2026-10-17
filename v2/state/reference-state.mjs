import { fenceOperationsToActiveWork } from "./active-work-operation-fence.mjs";
import { createReferenceState as createReferenceStateCore } from "./reference-state-core.mjs";

export function createReferenceState() {
  return fenceOperationsToActiveWork(createReferenceStateCore());
}
