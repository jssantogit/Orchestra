import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDelegatedChildTerminalStore } from "../../runtime/delegation/v2-child-terminal-store.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";

const sample = () => ({
  schema: "orchestra.delegated-child-terminal.v1",
  operationId: "op_delegated_exact",
  runtimeOwnerId: "owner_delegated_child_op_delegated_exact",
  process: { pid: 12345, startIdentity: "linux:boot:123" },
  terminal: {
    exitCode: 0, signal: null, timedOut: false,
    closedAt: "2026-10-20T14:00:00.000Z",
  },
});

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "orchestra-terminal-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ownerStore = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
  const terminalStore = createDelegatedChildTerminalStore({
    home, runtimeOwnerStore: ownerStore,
  });
  const receipt = sample();
  const owner = {
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: receipt.runtimeOwnerId, operationId: receipt.operationId,
    kind: "LOCAL_PROCESS", registeredAt: "2026-10-20T13:59:00.000Z",
    process: receipt.process,
    proof: { tokenHash: "sha256:" + "a".repeat(64) },
  };
  assert.equal((await ownerStore.register(owner)).ok, true);
  return { home, ownerStore, terminalStore, receipt };
}

test("native terminal receipt is immutable, owner-bound, replayable across reopen", async t => {
  const x = await fixture(t);
  assert.equal((await x.terminalStore.register(x.receipt)).ok, true);
  assert.deepEqual(await x.terminalStore.read(x.receipt.operationId), x.receipt);
  const other = createDelegatedChildTerminalStore({
    home: x.home, runtimeOwnerStore: x.ownerStore,
  });
  assert.deepEqual(await other.read(x.receipt.operationId), x.receipt);
  const replay = await other.register(x.receipt);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  const altered = structuredClone(x.receipt);
  altered.terminal.exitCode = 7;
  assert.equal((await other.register(altered)).ok, false);
});

test("native terminal receipt fails closed on absent/mismatched child owner", async t => {
  const x = await fixture(t);
  const altered = structuredClone(x.receipt);
  altered.process.pid++;
  assert.equal((await x.terminalStore.register(altered)).ok, false);
  const absent = createDelegatedChildTerminalStore({
    home: x.home,
    runtimeOwnerStore: { read: async () => null },
  });
  assert.equal((await absent.register(x.receipt)).ok, false);
});

test("native terminal receipt re-read validates digest and refuses tampered bytes", async t => {
  const x = await fixture(t);
  assert.equal((await x.terminalStore.register(x.receipt)).ok, true);
  const file = x.terminalStore.pathFor(x.receipt.operationId);
  writeFileSync(file, readFileSync(file, "utf8").replace('"exitCode":0', '"exitCode":7'));
  await assert.rejects(() => x.terminalStore.read(x.receipt.operationId),
    e => e?.code === "ORCHESTRA_DELEGATED_CHILD_TERMINAL_CORRUPT");
});

test("native terminal receipt never invents successful exit when process result is uncertain", async t => {
  const x = await fixture(t);
  const malformed = [
    { ...x.receipt, terminal: { ...x.receipt.terminal, exitCode: 0, signal: "SIGKILL" } },
    { ...x.receipt, terminal: { ...x.receipt.terminal, exitCode: null, signal: null, timedOut: false } },
    { ...x.receipt, terminal: { ...x.receipt.terminal, exitCode: 0, signal: null, timedOut: true } },
  ];
  for (const row of malformed) {
    assert.equal((await x.terminalStore.register(row)).ok, false);
  }
});