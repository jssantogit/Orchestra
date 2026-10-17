import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";

function owner(overrides = {}) {
  return {
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: "owner:durable",
    operationId: "op-durable",
    kind: "LOCAL_PROCESS",
    process: { pid: 4242, startIdentity: "host-start:durable" },
    proof: { tokenHash: `sha256:${"c".repeat(64)}` },
    registeredAt: "2026-10-17T02:10:00.000Z",
    ...overrides,
  };
}

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "orchestra-v2-runtime-owners-"));
  return {
    rootDir,
    async cleanup() {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function filesUnder(root) {
  const output = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  }
  await visit(root);
  return output;
}

test("Runtime Owner registration is durable and idempotent across store reopen", async () => {
  const fx = await fixture();
  try {
    const firstStore = createRuntimeOwnerStore({ rootDir: fx.rootDir });
    const first = await firstStore.register(owner());
    const replay = await firstStore.register(owner());

    assert.equal(first.ok, true);
    assert.equal(first.replayed, false);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);

    const reopened = createRuntimeOwnerStore({ rootDir: fx.rootDir });
    assert.deepEqual(await reopened.read("owner:durable"), owner());
  } finally {
    await fx.cleanup();
  }
});

test("Runtime Owner id cannot be rebound to a different Operation or process birth identity", async () => {
  const fx = await fixture();
  try {
    const store = createRuntimeOwnerStore({ rootDir: fx.rootDir });
    assert.equal((await store.register(owner())).ok, true);

    const differentOperation = await store.register(owner({ operationId: "op-other" }));
    const differentProcess = await store.register(owner({
      process: { pid: 4242, startIdentity: "host-start:replacement" },
    }));

    assert.equal(differentOperation.ok, false);
    assert.equal(differentOperation.reason, "RUNTIME_OWNER_ID_CONFLICT");
    assert.equal(differentProcess.ok, false);
    assert.equal(differentProcess.reason, "RUNTIME_OWNER_ID_CONFLICT");
    assert.deepEqual(await store.read("owner:durable"), owner());
  } finally {
    await fx.cleanup();
  }
});

test("concurrent identical Runtime Owner registration converges on one immutable record", async () => {
  const fx = await fixture();
  try {
    const left = createRuntimeOwnerStore({ rootDir: fx.rootDir });
    const right = createRuntimeOwnerStore({ rootDir: fx.rootDir });
    const results = await Promise.all([left.register(owner()), right.register(owner())]);

    assert.equal(results.filter((entry) => entry.ok).length, 2);
    assert.equal(results.filter((entry) => entry.replayed === false).length, 1);
    assert.equal(results.filter((entry) => entry.replayed === true).length, 1);
    assert.deepEqual(await left.read("owner:durable"), owner());
  } finally {
    await fx.cleanup();
  }
});

test("Runtime Owner storage hashes ids into paths instead of trusting caller path syntax", async () => {
  const fx = await fixture();
  try {
    const store = createRuntimeOwnerStore({ rootDir: fx.rootDir });
    const hostile = owner({ runtimeOwnerId: "../../outside/owner" });
    assert.equal((await store.register(hostile)).ok, true);
    assert.deepEqual(await store.read(hostile.runtimeOwnerId), hostile);

    const files = await filesUnder(fx.rootDir);
    assert.equal(files.length, 1);
    assert.equal(files[0].startsWith(fx.rootDir), true);
    assert.equal(files[0].includes(".."), false);
  } finally {
    await fx.cleanup();
  }
});

test("corrupted Runtime Owner record fails closed and is never silently replaced", async () => {
  const fx = await fixture();
  try {
    const store = createRuntimeOwnerStore({ rootDir: fx.rootDir });
    assert.equal((await store.register(owner())).ok, true);
    const [recordPath] = await filesUnder(fx.rootDir);
    const original = await readFile(recordPath, "utf8");
    const parsed = JSON.parse(original);
    parsed.owner.process.startIdentity = "tampered-start";
    await writeFile(recordPath, `${JSON.stringify(parsed)}\n`, "utf8");

    await assert.rejects(
      () => store.read("owner:durable"),
      (error) => error?.code === "ORCHESTRA_RUNTIME_OWNER_CORRUPT",
    );
    await assert.rejects(
      () => store.register(owner()),
      (error) => error?.code === "ORCHESTRA_RUNTIME_OWNER_CORRUPT",
    );
  } finally {
    await fx.cleanup();
  }
});

test("reading an unknown Runtime Owner is a factual null", async () => {
  const fx = await fixture();
  try {
    const store = createRuntimeOwnerStore({ rootDir: fx.rootDir });
    assert.equal(await store.read("owner:missing"), null);
  } finally {
    await fx.cleanup();
  }
});
