import { fenceOperationsToActiveWork } from "../../state/active-work-operation-fence.mjs";
import { createSqliteState as createSqliteStateCore } from "./sqlite-state-core.mjs";

export function createSqliteState(options) {
  return fenceOperationsToActiveWork(createSqliteStateCore(options));
}
