import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { createSqliteState as createSqliteStateCore } from "./sqlite-state-core.mjs";

const REGISTRY_SCHEMA_VERSION = 1;

function registryError(code, message, fields = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, fields);
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function digestText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

function ensureRecordShape(record) {
  if (!isRecord(record)
    || typeof record.imageId !== "string"
    || typeof record.schema !== "string"
    || typeof record.version !== "string"
    || typeof record.manifestDigest !== "string"
    || typeof record.manifestRef !== "string"
    || !isRecord(record.engineCompatibility)
    || !isRecord(record.providerAdapterCompatibility)
    || typeof record.createdAt !== "string") {
    throw registryError("ORCHESTRA_RUNTIME_IMAGE_REGISTRY_INVALID", "Runtime image registry record is malformed", {
      imageId: record?.imageId ?? null,
    });
  }
}

function parseRow(row) {
  if (!row) return null;
  let record;
  try {
    record = JSON.parse(row.record_json);
  } catch {
    throw registryError("ORCHESTRA_RUNTIME_IMAGE_REGISTRY_INVALID", `Runtime image registry record is not valid JSON: ${row.image_id}`, {
      imageId: row.image_id,
    });
  }
  ensureRecordShape(record);
  const matches = record.imageId === row.image_id
    && record.schema === row.schema
    && record.version === row.version
    && record.manifestDigest === row.manifest_digest
    && record.manifestRef === row.manifest_ref
    && canonicalJson(record.engineCompatibility) === row.engine_compatibility_json
    && canonicalJson(record.providerAdapterCompatibility) === row.provider_adapter_compatibility_json
    && record.createdAt === row.created_at
    && digestText(canonicalJson(record)) === row.record_digest;
  if (!matches) {
    throw registryError("ORCHESTRA_RUNTIME_IMAGE_REGISTRY_INVALID", `Runtime image registry columns disagree with record: ${row.image_id}`, {
      imageId: row.image_id,
    });
  }
  return record;
}

function initializeRegistry(db) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_image_registry_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1)
      ) STRICT;
    `);
    const meta = db.prepare("SELECT schema_version FROM runtime_image_registry_meta WHERE singleton = 1").get();
    if (meta && Number(meta.schema_version) > REGISTRY_SCHEMA_VERSION) {
      throw registryError(
        "ORCHESTRA_RUNTIME_IMAGE_SCHEMA_TOO_NEW",
        `Runtime image registry schema is newer than supported: ${meta.schema_version}`,
        { schemaVersion: Number(meta.schema_version), supportedSchemaVersion: REGISTRY_SCHEMA_VERSION },
      );
    }
    if (meta && Number(meta.schema_version) !== REGISTRY_SCHEMA_VERSION) {
      throw registryError(
        "ORCHESTRA_RUNTIME_IMAGE_SCHEMA_UNSUPPORTED",
        `Runtime image registry schema is unsupported: ${meta.schema_version}`,
        { schemaVersion: Number(meta.schema_version), supportedSchemaVersion: REGISTRY_SCHEMA_VERSION },
      );
    }
    if (!meta) {
      db.prepare("INSERT INTO runtime_image_registry_meta(singleton, schema_version) VALUES (1, ?)")
        .run(REGISTRY_SCHEMA_VERSION);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_images (
        image_id TEXT PRIMARY KEY,
        schema TEXT NOT NULL,
        version TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        manifest_ref TEXT NOT NULL,
        engine_compatibility_json TEXT NOT NULL,
        provider_adapter_compatibility_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        record_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS runtime_images_version_idx
        ON runtime_images(version, image_id);
    `);
  });
}

export function createSqliteRuntimeImageRegistry({ dbPath, timeoutMs = 5_000 } = {}) {
  if (typeof dbPath !== "string" || dbPath.trim().length === 0) throw new TypeError("dbPath is required");

  const core = createSqliteStateCore({ dbPath, timeoutMs });
  core.close();

  const db = new DatabaseSync(dbPath, { timeout: timeoutMs });
  try {
    initializeRegistry(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const getById = db.prepare("SELECT * FROM runtime_images WHERE image_id = ?");
  const listAll = db.prepare("SELECT * FROM runtime_images ORDER BY image_id ASC");
  const insert = db.prepare(`
    INSERT INTO runtime_images(
      image_id, schema, version, manifest_digest, manifest_ref,
      engine_compatibility_json, provider_adapter_compatibility_json,
      record_json, record_digest, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let closed = false;

  function assertOpen() {
    if (closed) throw registryError("ORCHESTRA_RUNTIME_IMAGE_REGISTRY_CLOSED", "Runtime image registry is closed");
  }

  return Object.freeze({
    schemaVersion: REGISTRY_SCHEMA_VERSION,

    inspect(imageId) {
      assertOpen();
      return parseRow(getById.get(imageId));
    },

    list() {
      assertOpen();
      return listAll.all().map(parseRow);
    },

    put(record) {
      assertOpen();
      ensureRecordShape(record);
      const recordJson = canonicalJson(record);
      const recordDigest = digestText(recordJson);
      return transaction(db, () => {
        const existingRow = getById.get(record.imageId);
        if (existingRow) {
          const existing = parseRow(existingRow);
          if (existingRow.record_digest === recordDigest && existingRow.record_json === recordJson) {
            return { ok: true, image: existing, replayed: true };
          }
          return { ok: false, reason: "RUNTIME_IMAGE_ID_CONFLICT", image: existing };
        }
        insert.run(
          record.imageId,
          record.schema,
          record.version,
          record.manifestDigest,
          record.manifestRef,
          canonicalJson(record.engineCompatibility),
          canonicalJson(record.providerAdapterCompatibility),
          recordJson,
          recordDigest,
          record.createdAt,
        );
        return { ok: true, image: JSON.parse(recordJson), replayed: false };
      });
    },

    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  });
}
