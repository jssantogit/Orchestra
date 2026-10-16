import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlobStore } from "../../v2/persistence/blob-store.mjs";

async function withStore(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-blobs-"));
  try {
    await fn({ root, store: createBlobStore({ root }) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function digestOf(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

test("blob publish is SHA-256 addressed and readable after reopening the store", async () => {
  await withStore(async ({ root, store }) => {
    const bytes = Buffer.from("orchestra-v2-blob", "utf8");
    const expected = digestOf(bytes);
    const published = await store.putBytes(bytes);

    assert.equal(published.digest, expected);
    assert.equal(published.size, bytes.length);
    assert.equal(published.replayed, false);
    assert.match(published.path.replaceAll("\\", "/"), /\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62}$/);
    assert.deepEqual(await readFile(published.path), bytes);

    const reopened = createBlobStore({ root });
    assert.deepEqual(await reopened.read(expected), bytes);
    assert.deepEqual(await reopened.verify(expected), { valid: true, digest: expected, size: bytes.length });
  });
});

test("repeated publish is idempotent and does not create duplicate objects", async () => {
  await withStore(async ({ store }) => {
    const bytes = Buffer.from("same-content", "utf8");
    const first = await store.putBytes(bytes);
    const replay = await store.putBytes(bytes);

    assert.equal(replay.digest, first.digest);
    assert.equal(replay.path, first.path);
    assert.equal(replay.replayed, true);
  });
});

test("concurrent identical publishes converge on one immutable object", async () => {
  await withStore(async ({ store }) => {
    const bytes = Buffer.alloc(64 * 1024, 7);
    const results = await Promise.all(Array.from({ length: 6 }, () => store.putBytes(bytes)));

    assert.equal(new Set(results.map((entry) => entry.digest)).size, 1);
    assert.equal(new Set(results.map((entry) => entry.path)).size, 1);
    assert.equal(results.filter((entry) => entry.replayed === false).length, 1);
    assert.equal(results.filter((entry) => entry.replayed === true).length, 5);
  });
});

test("corrupted published object is detected and never silently overwritten", async () => {
  await withStore(async ({ store }) => {
    const bytes = Buffer.from("trusted-content", "utf8");
    const published = await store.putBytes(bytes);
    await writeFile(published.path, Buffer.from("tampered", "utf8"));

    const verification = await store.verify(published.digest);
    assert.equal(verification.valid, false);
    assert.equal(verification.reason, "BLOB_DIGEST_MISMATCH");

    await assert.rejects(
      store.read(published.digest),
      (error) => error?.code === "ORCHESTRA_BLOB_CORRUPTION" && error?.digest === published.digest,
    );
    await assert.rejects(
      store.putBytes(bytes),
      (error) => error?.code === "ORCHESTRA_BLOB_CORRUPTION" && error?.digest === published.digest,
    );
  });
});

test("malformed digest is rejected before filesystem path resolution", async () => {
  await withStore(async ({ store }) => {
    for (const digest of ["sha256:../../escape", "md5:abc", "sha256:xyz", "", null]) {
      await assert.rejects(
        Promise.resolve().then(() => store.read(digest)),
        (error) => error?.code === "ORCHESTRA_BLOB_DIGEST_INVALID",
      );
    }
  });
});

test("missing digest returns factual not-found verification and read error", async () => {
  await withStore(async ({ store }) => {
    const digest = `sha256:${"0".repeat(64)}`;
    assert.deepEqual(await store.verify(digest), { valid: false, reason: "BLOB_NOT_FOUND", digest });
    await assert.rejects(
      store.read(digest),
      (error) => error?.code === "ORCHESTRA_BLOB_NOT_FOUND" && error?.digest === digest,
    );
  });
});
