import { parentPort, workerData } from "node:worker_threads";

import { createSqliteState } from "../../../v2/persistence/sqlite/sqlite-state.mjs";

const signal = new Int32Array(workerData.signal);
Atomics.add(signal, 0, 1);
Atomics.notify(signal, 0);
Atomics.wait(signal, 1, 0);

const state = createSqliteState({ dbPath: workerData.dbPath, timeoutMs: 10_000 });
try {
  const result = state.work.transition(workerData.command);
  parentPort.postMessage(result);
} finally {
  state.close();
}
