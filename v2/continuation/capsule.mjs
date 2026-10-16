import { createHash } from "node:crypto";

import { validateWorkUnitV2 } from "../domain/contracts.mjs";

const CAPSULE_SCHEMA = "orchestra.continuation-capsule.v2";
const DIGEST_ALGORITHM = "sha256";
const CANONICALIZATION = "orchestra.canonical-json.v1";
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
  if (!isRecord(value)) return null;

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

export function createContinuationCapsule({ work, facts } = {}) {
  if (!validateWorkUnitV2(work).valid) return result(false, { reason: "CONTINUATION_WORK_INVALID" });
  if (!isRecord(facts)) return result(false, { reason: "CONTINUATION_FACTS_INVALID" });

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
  if (!isRecord(capsule) || capsule.schema !== CAPSULE_SCHEMA) {
    return result(false, { reason: "CONTINUATION_SCHEMA_INVALID" });
  }
  if (!isRecord(capsule.facts) || findChatDependency(capsule.facts)) {
    return result(false, { reason: "CONTINUATION_CHAT_DEPENDENCY" });
  }
  if (!isRecord(capsule.digest)
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
