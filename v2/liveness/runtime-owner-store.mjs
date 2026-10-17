import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { validateRuntimeOwnerV2 } from "./contracts.mjs";

const RECORD_SCHEMA = "orchestra.runtime-owner-record.v1";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;

function success(payload = {}) {
  return { ok: true, ...payload };
}

function failure(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function corruptError(runtimeOwnerId, detail) {
  const error = new Error(`ORCHESTRA_RUNTIME_OWNER_CORRUPT:${runtimeOwnerId}:${detail}`);
  error.code = "ORCHESTRA_RUNTIME_OWNER_CORRUPT";
  error.runtimeOwnerId = runtimeOwnerId;
  error.detail = detail;
  return error;
}

function ownerPath(rootDir, runtimeOwnerId) {
  const key = createHash("sha256").update(runtimeOwnerId, "utf8").digest("hex");
  return {
    directory: join(rootDir, key.slice(0, 2)),
    target: join(rootDir, key.slice(0, 2), `${key}.json`),
  };
}

function makeEnvelope(owner) {
  return {
    schema: RECORD_SCHEMA,
    digest: sha256(canonicalJson(owner)),
    owner: clone(owner),
  };
}

function parseEnvelope(runtimeOwnerId, text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw corruptError(runtimeOwnerId, "INVALID_JSON");
  }

  if (!isRecord(envelope)
    || Object.keys(envelope).some((key) => !new Set(["schema", "digest", "owner"]).has(key))
    || envelope.schema !== RECORD_SCHEMA
    || !DIGEST_PATTERN.test(envelope.digest ?? "")
    || !validateRuntimeOwnerV2(envelope.owner).valid
    || envelope.owner.runtimeOwnerId !== runtimeOwnerId) {
    throw corruptError(runtimeOwnerId, "INVALID_RECORD");
  }

  const expectedDigest = sha256(canonicalJson(envelope.owner));
  if (envelope.digest !== expectedDigest) {
    throw corruptError(runtimeOwnerId, "DIGEST_MISMATCH");
  }

  return clone(envelope.owner);
}

async function removeTemp(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function createRuntimeOwnerStore({ rootDir } = {}) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new TypeError("rootDir is required");
  }
  const root = resolve(rootDir);

  async function read(runtimeOwnerId) {
    if (typeof runtimeOwnerId !== "string" || runtimeOwnerId.length === 0) return null;
    const { target } = ownerPath(root, runtimeOwnerId);
    let text;
    try {
      text = await readFile(target, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    return parseEnvelope(runtimeOwnerId, text);
  }

  async function existingResult(owner) {
    const existing = await read(owner.runtimeOwnerId);
    if (existing === null) return null;
    if (canonicalJson(existing) === canonicalJson(owner)) {
      return success({ owner: existing, replayed: true });
    }
    return failure("RUNTIME_OWNER_ID_CONFLICT", { owner: existing });
  }

  return Object.freeze({
    async register(owner) {
      if (!validateRuntimeOwnerV2(owner).valid) return failure("RUNTIME_OWNER_INVALID");

      const prior = await existingResult(owner);
      if (prior) return prior;

      const { directory, target } = ownerPath(root, owner.runtimeOwnerId);
      await mkdir(directory, { recursive: true });

      const envelope = makeEnvelope(owner);
      const bytes = `${JSON.stringify(envelope)}\n`;
      const temp = join(directory, `.${randomUUID()}.tmp`);
      let handle = null;
      try {
        handle = await open(temp, "wx", 0o600);
        await handle.writeFile(bytes, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;

        try {
          await link(temp, target);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          const raced = await existingResult(owner);
          if (!raced) throw corruptError(owner.runtimeOwnerId, "RACE_TARGET_MISSING");
          return raced;
        }

        return success({ owner: clone(owner), replayed: false });
      } finally {
        if (handle) {
          try {
            await handle.close();
          } catch {
            // Cleanup best effort; preserve the primary operation result/error.
          }
        }
        await removeTemp(temp);
      }
    },

    read,
  });
}
