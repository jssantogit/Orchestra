import { createHash } from "node:crypto";

const EXPECTED_SCHEMAS = Object.freeze({
  candidate: "orchestra.candidate.v1",
  evidence: "orchestra.evidence.v1",
  continuation: "orchestra.work-continuation.v1",
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(code, payload = {}) {
  return { ok: false, code, successClaim: false, ...payload };
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeBytes(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return null;
}

function deterministicWorkId(projectId, commandId) {
  const identity = JSON.stringify({ projectId, commandId });
  return `work_migration_${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

function inventoryEvidence(inventory, classificationByPath) {
  return inventory.map((entry) => {
    const classification = classificationByPath.get(entry.path)?.result ?? null;
    return {
      path: entry.path,
      digest: entry.digest ?? null,
      category: entry.category ?? null,
      disposition: classification?.disposition ?? "UNSUPPORTED_BLOCKED",
      diagnostic: classification?.diagnostic ?? null,
    };
  });
}

function prepareFact({ fact, expectedSchema, inventoryByPath, classificationByPath }) {
  if (!isRecord(fact) || !nonEmptyString(fact.path)) {
    return fail("MIGRATION_FACT_INVALID");
  }
  if (fact.provenanceComplete !== true) {
    return fail("MIGRATION_FACT_PROVENANCE_REQUIRED", { path: fact.path });
  }

  const entry = inventoryByPath.get(fact.path);
  const classification = classificationByPath.get(fact.path)?.result ?? null;
  if (!entry || classification?.disposition !== "CLEAN_IMPORT") {
    return fail("MIGRATION_FACT_NOT_CLEAN_IMPORT", { path: fact.path });
  }

  const bytes = normalizeBytes(fact.bytes);
  if (!bytes) return fail("MIGRATION_FACT_BYTES_REQUIRED", { path: fact.path });

  const actualDigest = digest(bytes);
  if (actualDigest !== entry.digest) {
    return fail("MIGRATION_FACT_DIGEST_MISMATCH", {
      path: fact.path,
      expectedDigest: entry.digest ?? null,
      actualDigest,
    });
  }

  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail("MIGRATION_FACT_JSON_INVALID", { path: fact.path });
  }

  if (!isRecord(record) || record.schema !== expectedSchema || entry.schema !== expectedSchema) {
    return fail("MIGRATION_FACT_SCHEMA_MISMATCH", {
      path: fact.path,
      expectedSchema,
      actualSchema: record?.schema ?? null,
    });
  }

  return { ok: true, path: fact.path, bytes, digest: actualDigest, record };
}

function prepareArchive({ archive, inventoryByPath, classificationByPath }) {
  if (!isRecord(archive) || !nonEmptyString(archive.path)) {
    return fail("MIGRATION_ARCHIVE_INVALID");
  }
  const entry = inventoryByPath.get(archive.path);
  const classification = classificationByPath.get(archive.path)?.result ?? null;
  if (!entry || classification?.disposition !== "PRIVATE_ARCHIVE") {
    return fail("MIGRATION_ARCHIVE_NOT_PRIVATE", { path: archive.path });
  }
  const bytes = normalizeBytes(archive.bytes);
  if (!bytes) return fail("MIGRATION_ARCHIVE_BYTES_REQUIRED", { path: archive.path });
  const actualDigest = digest(bytes);
  if (actualDigest !== entry.digest) {
    return fail("MIGRATION_ARCHIVE_DIGEST_MISMATCH", {
      path: archive.path,
      expectedDigest: entry.digest ?? null,
      actualDigest,
    });
  }
  return { ok: true, path: archive.path, bytes, digest: actualDigest };
}

function validateRelationships(candidate, evidence, continuation) {
  const taskId = candidate.record.taskId;
  const candidateId = candidate.record.candidateId;
  const candidateGeneration = candidate.record.generation;
  if (!nonEmptyString(taskId) || !nonEmptyString(candidateId)
    || !Number.isInteger(candidateGeneration) || candidateGeneration < 0) {
    return fail("MIGRATION_CANDIDATE_IDENTITY_INVALID");
  }

  if (continuation.record?.task?.taskId !== taskId) {
    return fail("MIGRATION_CONTINUATION_TASK_MISMATCH");
  }
  if (continuation.record?.candidate?.candidateId !== candidateId
    || continuation.record?.candidate?.taskId !== taskId
    || continuation.record?.candidate?.generation !== candidateGeneration) {
    return fail("MIGRATION_CONTINUATION_CANDIDATE_MISMATCH");
  }

  for (const fact of evidence) {
    if (fact.record.taskId !== taskId
      || fact.record.candidateId !== candidateId
      || fact.record.candidateGeneration !== candidateGeneration) {
      return fail("MIGRATION_EVIDENCE_CANDIDATE_MISMATCH", { path: fact.path });
    }
  }

  return { ok: true, taskId };
}

async function sealFact(blobs, fact) {
  const sealed = await blobs.putBytes(fact.bytes);
  if (sealed?.digest !== fact.digest) {
    return fail("MIGRATION_BLOB_DIGEST_MISMATCH", {
      path: fact.path,
      expectedDigest: fact.digest,
      actualDigest: sealed?.digest ?? null,
    });
  }
  const verification = await blobs.verify(fact.digest);
  if (!verification?.valid) {
    return fail("MIGRATION_BLOB_VERIFY_FAILED", {
      path: fact.path,
      digest: fact.digest,
      reason: verification?.reason ?? null,
    });
  }
  return { ok: true, sealed };
}

export function createLegacyMigrationImporter({ projectRegistry } = {}) {
  if (!projectRegistry || typeof projectRegistry.registerWorkspace !== "function"
    || !projectRegistry.state?.work || typeof projectRegistry.state.work.open !== "function"
    || !projectRegistry.blobs || typeof projectRegistry.blobs.putBytes !== "function"
    || typeof projectRegistry.blobs.verify !== "function") {
    throw new TypeError("projectRegistry with state.work and blobs is required");
  }

  return Object.freeze({
    async apply(input = {}) {
      const {
        workspace,
        commandId,
        runtimeImage,
        instructionEpoch,
        trustMode,
        inventory = [],
        classifications = [],
        durableFacts = {},
        privateArchives = [],
      } = input;

      if (!nonEmptyString(workspace) || !nonEmptyString(commandId)
        || !nonEmptyString(runtimeImage) || !Number.isInteger(instructionEpoch) || instructionEpoch < 0
        || !nonEmptyString(trustMode) || !Array.isArray(inventory) || !Array.isArray(classifications)
        || !isRecord(durableFacts) || !Array.isArray(privateArchives)) {
        return fail("MIGRATION_IMPORT_INVALID");
      }

      const inventoryByPath = new Map();
      for (const entry of inventory) {
        if (!isRecord(entry) || !nonEmptyString(entry.path) || inventoryByPath.has(entry.path)) {
          return fail("MIGRATION_INVENTORY_INVALID");
        }
        inventoryByPath.set(entry.path, entry);
      }

      const classificationByPath = new Map();
      for (const classification of classifications) {
        if (!isRecord(classification) || !nonEmptyString(classification.path)
          || !isRecord(classification.result) || classificationByPath.has(classification.path)) {
          return fail("MIGRATION_CLASSIFICATION_INVALID");
        }
        classificationByPath.set(classification.path, classification);
      }

      const evidence = inventoryEvidence(inventory, classificationByPath);
      const blocked = evidence.filter((item) => item.disposition === "UNSUPPORTED_BLOCKED");
      if (blocked.length > 0 || inventory.some((entry) => !classificationByPath.has(entry.path))) {
        return fail("MIGRATION_BLOCKED", { inventoryEvidence: evidence });
      }

      const candidate = prepareFact({
        fact: durableFacts.candidate,
        expectedSchema: EXPECTED_SCHEMAS.candidate,
        inventoryByPath,
        classificationByPath,
      });
      if (!candidate.ok) return candidate;

      if (!Array.isArray(durableFacts.evidence)) return fail("MIGRATION_EVIDENCE_INVALID");
      const preparedEvidence = [];
      for (const fact of durableFacts.evidence) {
        const prepared = prepareFact({
          fact,
          expectedSchema: EXPECTED_SCHEMAS.evidence,
          inventoryByPath,
          classificationByPath,
        });
        if (!prepared.ok) return prepared;
        preparedEvidence.push(prepared);
      }

      const continuation = prepareFact({
        fact: durableFacts.continuation,
        expectedSchema: EXPECTED_SCHEMAS.continuation,
        inventoryByPath,
        classificationByPath,
      });
      if (!continuation.ok) return continuation;

      const preparedArchives = [];
      for (const archive of privateArchives) {
        const prepared = prepareArchive({ archive, inventoryByPath, classificationByPath });
        if (!prepared.ok) return prepared;
        preparedArchives.push(prepared);
      }

      const relationships = validateRelationships(candidate, preparedEvidence, continuation);
      if (!relationships.ok) return relationships;

      let registration;
      try {
        registration = await projectRegistry.registerWorkspace({
          root: workspace,
          runtimeImage,
          instructionEpoch,
          trustMode,
        });
      } catch (error) {
        return fail("MIGRATION_PROJECT_REGISTRATION_FAILED", { reason: error?.code ?? error?.message ?? "UNKNOWN" });
      }
      if (!registration?.ok || !registration.project) {
        return fail("MIGRATION_PROJECT_REGISTRATION_FAILED", { reason: registration?.reason ?? null });
      }
      const project = registration.project;

      const factsToSeal = [candidate, ...preparedEvidence, continuation];
      for (const fact of factsToSeal) {
        let sealed;
        try {
          sealed = await sealFact(projectRegistry.blobs, fact);
        } catch (error) {
          return fail("MIGRATION_BLOB_WRITE_FAILED", { path: fact.path, reason: error?.code ?? error?.message ?? "UNKNOWN" });
        }
        if (!sealed.ok) return sealed;
      }

      const archives = [];
      for (const archive of preparedArchives) {
        let sealed;
        try {
          sealed = await sealFact(projectRegistry.blobs, archive);
        } catch (error) {
          return fail("MIGRATION_ARCHIVE_WRITE_FAILED", { path: archive.path, reason: error?.code ?? error?.message ?? "UNKNOWN" });
        }
        if (!sealed.ok) return sealed;
        archives.push({
          path: archive.path,
          digest: archive.digest,
          size: sealed.sealed.size,
          private: true,
        });
      }

      const work = {
        schema: "orchestra.work-unit.v2",
        workId: deterministicWorkId(project.projectId, commandId),
        projectId: project.projectId,
        taskId: relationships.taskId,
        generation: 0,
        runtimeImage: project.runtime.pinnedImage,
        instructionEpoch: project.runtime.instructionEpoch,
        state: "IMPORTED",
        scopeRef: null,
        directionRef: null,
        candidateRef: candidate.digest,
        evidenceRefs: preparedEvidence.map((fact) => fact.digest),
        blockers: [],
        continuationRef: continuation.digest,
      };

      let workResult;
      try {
        workResult = projectRegistry.state.work.open(work);
      } catch (error) {
        return fail("MIGRATION_WORK_IMPORT_FAILED", {
          reason: error?.code ?? error?.message ?? "UNKNOWN",
          project,
          archives,
          inventoryEvidence: evidence,
        });
      }
      if (!workResult?.ok || !workResult.work) {
        return fail("MIGRATION_WORK_IMPORT_FAILED", {
          reason: workResult?.reason ?? null,
          project,
          archives,
          inventoryEvidence: evidence,
        });
      }

      return {
        ok: true,
        code: "MIGRATION_DURABLE_IMPORT_APPLIED",
        project,
        work: workResult.work,
        archives,
        inventoryEvidence: evidence,
        replayed: workResult.replayed === true,
        successClaim: false,
      };
    },
  });
}
