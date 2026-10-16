import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const DIGEST_RE = /^sha256:([0-9a-f]{64})$/;

function blobError(code, message, fields = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, fields);
  return error;
}

function assertDigest(digest) {
  if (typeof digest !== "string") {
    throw blobError("ORCHESTRA_BLOB_DIGEST_INVALID", "Blob digest must be a sha256 digest", { digest });
  }
  const match = DIGEST_RE.exec(digest);
  if (!match) {
    throw blobError("ORCHESTRA_BLOB_DIGEST_INVALID", "Blob digest must be sha256:<64 lowercase hex>", { digest });
  }
  return match[1];
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeBytes(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError("bytes must be a Buffer or Uint8Array");
}

async function syncFile(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not portable (notably on Windows). File fsync above
    // remains mandatory; directory sync is best-effort only.
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function createBlobStore({ root } = {}) {
  if (typeof root !== "string" || root.trim().length === 0) throw new TypeError("root is required");
  const blobRoot = resolve(root);
  const tempRoot = join(blobRoot, "tmp");

  function pathFor(digest) {
    const hex = assertDigest(digest);
    return join(blobRoot, "sha256", hex.slice(0, 2), hex.slice(2));
  }

  async function verify(digest) {
    const target = pathFor(digest);
    let bytes;
    try {
      bytes = await readFile(target);
    } catch (error) {
      if (error?.code === "ENOENT") return { valid: false, reason: "BLOB_NOT_FOUND", digest };
      throw error;
    }

    const actual = sha256(bytes);
    if (actual !== digest) {
      return { valid: false, reason: "BLOB_DIGEST_MISMATCH", digest, actualDigest: actual };
    }
    return { valid: true, digest, size: bytes.length };
  }

  function corruptionError(digest, verification) {
    return blobError(
      "ORCHESTRA_BLOB_CORRUPTION",
      `Blob ${digest} exists but does not match its content address`,
      { digest, actualDigest: verification?.actualDigest ?? null },
    );
  }

  async function read(digest) {
    const target = pathFor(digest);
    let bytes;
    try {
      bytes = await readFile(target);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw blobError("ORCHESTRA_BLOB_NOT_FOUND", `Blob not found: ${digest}`, { digest });
      }
      throw error;
    }

    const actual = sha256(bytes);
    if (actual !== digest) throw corruptionError(digest, { actualDigest: actual });
    return bytes;
  }

  async function putBytes(input) {
    const bytes = normalizeBytes(input);
    const digest = sha256(bytes);
    const target = pathFor(digest);

    const existing = await verify(digest);
    if (existing.valid) {
      return { digest, size: bytes.length, path: target, replayed: true };
    }
    if (existing.reason !== "BLOB_NOT_FOUND") throw corruptionError(digest, existing);

    const targetDir = join(blobRoot, "sha256", digest.slice(7, 9));
    await mkdir(targetDir, { recursive: true });
    await mkdir(tempRoot, { recursive: true });

    const temp = join(tempRoot, `${randomUUID()}.tmp`);
    let published = false;
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      await syncFile(temp);

      try {
        // A hard-link publication is atomic on the same filesystem and refuses
        // to replace an existing digest path on both POSIX and Windows.
        await link(temp, target);
        published = true;
        await syncDirectoryBestEffort(targetDir);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const winner = await verify(digest);
        if (!winner.valid) throw corruptionError(digest, winner);
      }

      const finalVerification = await verify(digest);
      if (!finalVerification.valid) throw corruptionError(digest, finalVerification);
      return {
        digest,
        size: bytes.length,
        path: target,
        replayed: !published,
      };
    } finally {
      await unlink(temp).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  return Object.freeze({
    root: blobRoot,
    pathFor,
    putBytes,
    read,
    verify,
  });
}
