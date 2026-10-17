import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const helper = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "helpers/sqlite-open-state-worker.mjs",
);

function workerResult(worker) {
  return new Promise((resolveResult, reject) => {
    worker.once("message", resolveResult);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`SQLite open worker exited with code ${code}`));
    });
  });
}

async function waitUntilReady(signal, count) {
  const deadline = Date.now() + 10_000;
  while (Atomics.load(signal, 0) < count) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for SQLite open workers");
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
}

async function concurrentOpenRound(dbPath, count = 12) {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const signal = new Int32Array(buffer);
  const workers = Array.from({ length: count }, () => new Worker(helper, {
    workerData: { dbPath, signal: buffer },
  }));
  const results = workers.map(workerResult);

  await waitUntilReady(signal, count);
  Atomics.store(signal, 1, 1);
  Atomics.notify(signal, 1, count);
  return Promise.all(results);
}

test("concurrent global processes serialize SQLite schema initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-schema-concurrency-"));
  try {
    for (let round = 0; round < 3; round += 1) {
      const dbPath = join(root, `round-${round}.db`);
      const results = await concurrentOpenRound(dbPath);
      assert.equal(
        results.every((entry) => entry.ok),
        true,
        `all concurrent openers must converge: ${JSON.stringify(results.filter((entry) => !entry.ok))}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
