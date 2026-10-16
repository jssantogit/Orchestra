import { createHash } from "node:crypto";

import { validateWorkUnitV2 } from "../domain/contracts.mjs";

const CAPSULE_SCHEMA = "orchestra.continuation-capsule.v2";
const DIGEST_ALGORITHM = "sha256";
const CANONICALIZATION = "orchestra.canonical-json.v1";
const CAPSULE_KEYS = new Set([
  "schema", "projectId", "workId", "taskId", "generation", "runtimeImage", "instructionEpoch",
  "scopeRef", "directionRef", "candidateRef", "evidenceRefs", "blockers", "facts", "digest",
]);
const DIGEST_KEYS = new Set(["algorithm", "canonicalization", "value"]);
const FORBIDDEN_CHAT_KEYS = new Set([
  "transcript",
  "providertranscript",
  "chathistory",
  "prompt",
  "hiddenreasoning",
  "chainofthought",
  "sessionid",
  "conversationid",
  "mainsessionid",
  "ownersessionid",
]);

function result(valid, payload = {}) {
  return valid ? { valid: true, ...payload } : { valid: false, ...payload };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value) {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeKey(key) {
  return String(key).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function findChatDependency(value, path = "facts") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findChatDependency(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainRecord(value)) return null;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CHAT_KEYS.has(normalizeKey(key))) return `${path}.${key}`;
    const found = findChatDependency(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function canonicalValue(value, path = "$", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`non-JSON value at ${path}`);
  if (seen.has(value)) throw new TypeError(`cyclic value at ${path}`);
  seen.add(value);

  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`, seen));
  } else {
    if (!isPlainRecord(value)) throw new TypeError(`non-plain object at ${path}`);
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = canonicalValue(value[key], `${path}.${key}`, seen);
    }
  }

  seen.delete(value);
  return normalized;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function digestPayload(payload) {
  return `${DIGEST_ALGORITHM}:${createHash(DIGEST_ALGORITHM).update(canonicalJson(payload), "utf8").digest("hex")}`;
}

function capsulePayload(capsule) {
  return {
    schema: capsule.schema,
    projectId: capsule.projectId,
    workId: capsule.workId,
    taskId: capsule.taskId,
    generation: capsule.generation,
    runtimeImage: capsule.runtimeImage,
    instructionEpoch: capsule.instructionEpoch,
    scopeRef: capsule.scopeRef,
    directionRef: capsule.directionRef,
    candidateRef: capsule.candidateRef,
    evidenceRefs: capsule.evidenceRefs,
    blockers: capsule.blockers,
    facts: capsule.facts,
  };
}

function validateCapsuleShape(capsule) {
  if (!isPlainRecord(capsule) || capsule.schema !== CAPSULE_SCHEMA || !hasOnlyKeys(capsule, CAPSULE_KEYS)) return false;
  for (const key of ["projectId", "workId", "taskId", "runtimeImage"]) {
    if (!isNonEmptyString(capsule[key])) return false;
  }
  if (!Number.isInteger(capsule.generation) || capsule.generation < 0
    || !Number.isInteger(capsule.instructionEpoch) || capsule.instructionEpoch < 0) return false;
  for (const key of ["scopeRef", "directionRef", "candidateRef"]) {
    if (capsule[key] !== null && !isNonEmptyString(capsule[key])) return false;
  }
  if (!Array.isArray(capsule.evidenceRefs) || capsule.evidenceRefs.some((entry) => !isNonEmptyString(entry))) return false;
  if (!Array.isArray(capsule.blockers) || !isPlainRecord(capsule.facts)) return false;
  return true;
}

export function createContinuationCapsule({ work, facts } = {}) {
  if (!validateWorkUnitV2(work).valid) return result(false, { reason: "CONTINUATION_WORK_INVALID" });
  if (!isPlainRecord(facts)) return result(false, { reason: "CONTINUATION_FACTS_INVALID" });

  const dependency = findChatDependency(facts);
  if (dependency) return result(false, { reason: "CONTINUATION_CHAT_DEPENDENCY", path: dependency });

  const capsule = {
    schema: CAPSULE_SCHEMA,
    projectId: work.projectId,
    workId: work.workId,
    taskId: work.taskId,
    generation: work.generation,
    runtimeImage: work.runtimeImage,
    instructionEpoch: work.instructionEpoch,
    scopeRef: work.scopeRef,
    directionRef: work.directionRef,
    candidateRef: work.candidateRef,
    evidenceRefs: structuredClone(work.evidenceRefs),
    blockers: structuredClone(work.blockers),
    facts: structuredClone(facts),
  };

  try {
    capsule.digest = {
      algorithm: DIGEST_ALGORITHM,
      canonicalization: CANONICALIZATION,
      value: digestPayload(capsulePayload(capsule)),
    };
  } catch {
    return result(false, { reason: "CONTINUATION_FACTS_INVALID" });
  }

  return result(true, { capsule });
}

export function verifyContinuationCapsule(capsule) {
  if (!validateCapsuleShape(capsule)) {
    return result(false, { reason: "CONTINUATION_SCHEMA_INVALID" });
  }
  const dependency = findChatDependency(capsule.facts);
  if (dependency) return result(false, { reason: "CONTINUATION_CHAT_DEPENDENCY", path: dependency });
  if (!isPlainRecord(capsule.digest)
    || !hasOnlyKeys(capsule.digest, DIGEST_KEYS)
    || capsule.digest.algorithm !== DIGEST_ALGORITHM
    || capsule.digest.canonicalization !== CANONICALIZATION
    || typeof capsule.digest.value !== "string") {
    return result(false, { reason: "CONTINUATION_DIGEST_METADATA_INVALID" });
  }

  let expected;
  try {
    expected = digestPayload(capsulePayload(capsule));
  } catch {
    return result(false, { reason: "CONTINUATION_FACTS_INVALID" });
  }
  if (expected !== capsule.digest.value) {
    return result(false, { reason: "CONTINUATION_DIGEST_MISMATCH" });
  }
  return result(true);
}
