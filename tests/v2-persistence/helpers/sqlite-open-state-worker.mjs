import { parentPort, workerData } from "node:worker_threads";

import { createSqliteState } from "../../../v2/persistence/sqlite/sqlite-state.mjs";

const signal = new Int32Array(workerData.signal);
Atomics.add(signal, 0, 1);
Atomics.notify(signal, 0);
Atomics.wait(signal, 1, 0);

try {
  const state = createSqliteState({ dbPath: workerData.dbPath, timeoutMs: 10_000 });
  state.close();
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    code: error?.code ?? null,
    message: error?.message ?? String(error),
  });
}
