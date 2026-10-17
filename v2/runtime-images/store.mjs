import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

import { createBlobStore } from "../persistence/blob-store.mjs";
import { validateRuntimeImageRecord } from "./contracts.mjs";

const MANIFEST_SCHEMA = "orchestra.runtime-image-manifest.v2";

function imageError(code, message, fields = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, fields);
  return error;
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value, field) {
  if (!isRecord(value)) {
    throw imageError("ORCHESTRA_RUNTIME_IMAGE_METADATA_INVALID", `${field} must be an object`, { field });
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw imageError("ORCHESTRA_RUNTIME_IMAGE_METADATA_INVALID", `${field} must contain JSON data`, { field });
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validFilePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\\")) return false;
  if (filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)) return false;
  return filePath.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function normalizeFiles(files) {
  if (!isRecord(files) || Object.keys(files).length === 0) {
    throw imageError("ORCHESTRA_RUNTIME_IMAGE_CONTENT_INVALID", "files must be a non-empty path-to-bytes object");
  }
  const normalized = [];
  for (const [filePath, inputBytes] of Object.entries(files)) {
    if (!validFilePath(filePath)) {
      throw imageError("ORCHESTRA_RUNTIME_IMAGE_CONTENT_INVALID", `Invalid runtime image path: ${filePath}`, { filePath });
    }
    if (!(Buffer.isBuffer(inputBytes) || inputBytes instanceof Uint8Array)) {
      throw imageError("ORCHESTRA_RUNTIME_IMAGE_CONTENT_INVALID", `Runtime image file must contain bytes: ${filePath}`, { filePath });
    }
    const bytes = Buffer.from(inputBytes);
    normalized.push({ path: filePath, digest: digestBytes(bytes), size: bytes.length, bytes });
  }
  normalized.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return normalized;
}

function parseManifest(bytes, imageId) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { valid: false, reason: "MANIFEST_INVALID", imageId };
  }
  if (!isRecord(manifest) || manifest.schema !== MANIFEST_SCHEMA || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { valid: false, reason: "MANIFEST_INVALID", imageId };
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!isRecord(entry) || !validFilePath(entry.path) || !/^sha256:[0-9a-f]{64}$/.test(entry.digest)
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || seen.has(entry.path)) {
      return { valid: false, reason: "MANIFEST_INVALID", imageId };
    }
    seen.add(entry.path);
  }
  return { valid: true, manifest };
}

function sameMetadata(left, right) {
  return left.version === right.version
    && canonicalJson(left.engineCompatibility) === canonicalJson(right.engineCompatibility)
    && canonicalJson(left.providerAdapterCompatibility) === canonicalJson(right.providerAdapterCompatibility);
}

async function serialize(key, queues, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  let release;
  const barrier = new Promise((resolveBarrier) => { release = resolveBarrier; });
  const queued = previous.then(() => barrier);
  queues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}

export function createRuntimeImageStore({ orchestraHome } = {}) {
  if (typeof orchestraHome !== "string" || orchestraHome.trim().length === 0) {
    throw new TypeError("orchestraHome is required");
  }
  const root = resolve(orchestraHome, "runtime-images");
  const blobs = createBlobStore({ root: join(root, "blobs") });
  const installed = new Map();
  const installQueues = new Map();

  async function verify(imageId) {
    const image = installed.get(imageId);
    if (!image) return { valid: false, reason: "IMAGE_NOT_INSTALLED", imageId };
    const recordVerification = validateRuntimeImageRecord(image);
    if (!recordVerification.valid) {
      return { valid: false, reason: "IMAGE_RECORD_INVALID", imageId, recordReason: recordVerification.reason };
    }
    const manifestVerification = await blobs.verify(image.manifestDigest);
    if (!manifestVerification.valid) {
      return { valid: false, reason: "MANIFEST_DIGEST_MISMATCH", imageId, blobVerification: manifestVerification };
    }
    let manifestBytes;
    try {
      manifestBytes = await blobs.read(image.manifestDigest);
    } catch (error) {
      return { valid: false, reason: "MANIFEST_DIGEST_MISMATCH", imageId, error };
    }
    const parsed = parseManifest(manifestBytes, imageId);
    if (!parsed.valid) return parsed;
    for (const entry of parsed.manifest.files) {
      const contentVerification = await blobs.verify(entry.digest);
      if (!contentVerification.valid) {
        return { valid: false, reason: "CONTENT_DIGEST_MISMATCH", imageId, filePath: entry.path, blobVerification: contentVerification };
      }
      if (contentVerification.size !== entry.size) {
        return { valid: false, reason: "CONTENT_SIZE_MISMATCH", imageId, filePath: entry.path };
      }
    }
    return { valid: true, imageId, manifestDigest: image.manifestDigest };
  }

  async function install(input = {}) {
    const files = normalizeFiles(input.files);
    const manifest = {
      schema: MANIFEST_SCHEMA,
      files: files.map(({ path, digest, size }) => ({ path, digest, size })),
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
    const imageId = digestBytes(manifestBytes);
    if (input.imageId !== undefined && input.imageId !== imageId) {
      throw imageError(
        "ORCHESTRA_RUNTIME_IMAGE_IDENTITY_CONFLICT",
        "Declared runtime image identity does not match manifest and file content",
        { imageId: input.imageId, actualImageId: imageId },
      );
    }
    const metadata = {
      version: input.version,
      engineCompatibility: cloneJson(input.engineCompatibility, "engineCompatibility"),
      providerAdapterCompatibility: cloneJson(input.providerAdapterCompatibility, "providerAdapterCompatibility"),
    };
    const candidate = {
      schema: "orchestra.runtime-image.v2",
      imageId,
      ...metadata,
      manifestDigest: imageId,
      manifestRef: `blob:${imageId}`,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    const candidateValidation = validateRuntimeImageRecord(candidate);
    if (!candidateValidation.valid) {
      throw imageError("ORCHESTRA_RUNTIME_IMAGE_INVALID", candidateValidation.reason, { reason: candidateValidation.reason });
    }

    return serialize(imageId, installQueues, async () => {
      const existing = installed.get(imageId);
      if (existing) {
        if (!sameMetadata(existing, metadata)) {
          throw imageError(
            "ORCHESTRA_RUNTIME_IMAGE_IDENTITY_CONFLICT",
            `Runtime image ${imageId} was already installed with different metadata`,
            { imageId },
          );
        }
        const verification = await verify(imageId);
        if (!verification.valid) {
          throw imageError(
            "ORCHESTRA_RUNTIME_IMAGE_INTEGRITY_FAILED",
            `Runtime image ${imageId} failed integrity verification`,
            { imageId, verification },
          );
        }
        return existing;
      }

      for (const file of files) await blobs.putBytes(file.bytes);
      await blobs.putBytes(manifestBytes);
      const immutable = deepFreeze(candidate);
      installed.set(imageId, immutable);
      return immutable;
    });
  }

  async function readManifest(imageId) {
    const image = installed.get(imageId);
    if (!image) throw imageError("ORCHESTRA_RUNTIME_IMAGE_NOT_FOUND", `Runtime image not installed: ${imageId}`, { imageId });
    return Buffer.from(await blobs.read(image.manifestDigest));
  }

  async function readFile(imageId, filePath) {
    const verification = await verify(imageId);
    if (!verification.valid) {
      throw imageError("ORCHESTRA_RUNTIME_IMAGE_INTEGRITY_FAILED", `Runtime image ${imageId} failed integrity verification`, { imageId, verification });
    }
    const manifest = JSON.parse((await blobs.read(imageId)).toString("utf8"));
    const entry = manifest.files.find((file) => file.path === filePath);
    if (!entry) throw imageError("ORCHESTRA_RUNTIME_IMAGE_FILE_NOT_FOUND", `Runtime image file not found: ${filePath}`, { imageId, filePath });
    return Buffer.from(await blobs.read(entry.digest));
  }

  function locationFor(imageId) {
    const image = installed.get(imageId);
    if (!image) throw imageError("ORCHESTRA_RUNTIME_IMAGE_NOT_FOUND", `Runtime image not installed: ${imageId}`, { imageId });
    return blobs.pathFor(image.manifestDigest);
  }

  return Object.freeze({
    root,
    install,
    verify,
    readManifest,
    readFile,
    locationFor,
  });
}
