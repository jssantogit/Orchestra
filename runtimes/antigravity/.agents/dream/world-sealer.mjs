import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Canonical } from "./canonical.mjs";
import { DREAM_SCHEMAS, validateDreamRecord } from "./records.mjs";

/**
 * Validates whether an actor identity is a factual, resolved role.
 * UNKNOWN, UNRESOLVED, or LOW confidence actor identities are rejected.
 *
 * @param {unknown} actor
 * @returns {boolean}
 */
export function isFactualActorIdentity(actor) {
  if (!actor) return false;
  if (typeof actor === "string") {
    const trimmed = actor.trim();
    if (trimmed.length === 0) return false;
    const upper = trimmed.toUpperCase();
    if (
      upper === "UNKNOWN" ||
      upper === "UNRESOLVED" ||
      upper === "LOW" ||
      upper === "UNKNOWN_ROLE"
    ) {
      return false;
    }
    return true;
  }
  if (typeof actor === "object" && actor !== null && !Array.isArray(actor)) {
    if (actor.resolved === false) return false;
    if (
      typeof actor.confidence === "string" &&
      actor.confidence.trim().toUpperCase() === "LOW"
    ) {
      return false;
    }
    const role = actor.role || actor.actor || actor.identity;
    if (!role || typeof role !== "string") return false;
    const roleUpper = role.trim().toUpperCase();
    if (
      roleUpper === "UNKNOWN" ||
      roleUpper === "UNRESOLVED" ||
      roleUpper === "UNKNOWN_ROLE"
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Recomputes the event hash over the base event object (excluding event_hash)
 * and compares it to event.event_hash.
 *
 * @param {Record<string, unknown>} event
 * @returns {boolean}
 */
function verifyEventHash(event) {
  if (!event || typeof event !== "object") return false;
  const { event_hash, ...base } = event;
  if (!event_hash || typeof event_hash !== "string") return false;
  try {
    const computed = sha256Canonical(base);
    return computed === event_hash;
  } catch {
    return false;
  }
}

/**
 * Validates evidence references in an outcome record.
 * If evidence requires verification (e.g. tests require validation),
 * ensures evidence references are present, non-empty, and refer to existing execution records.
 *
 * @param {Record<string, unknown>} outcome
 * @param {string | undefined} repoRoot
 * @param {Array<Record<string, unknown>>} allEvents
 * @returns {string[]}
 */
function checkEvidenceRequirement(outcome, repoRoot, allEvents) {
  const errors = [];
  const evSummary = outcome.evidence_summary || {};

  const requiresVerification =
    evSummary.requires_validation === true ||
    evSummary.validation_fresh === true ||
    (typeof evSummary.tests === "string" &&
      evSummary.tests !== "NOT_REQUIRED" &&
      evSummary.tests !== "UNKNOWN");

  if (requiresVerification) {
    const provenance = outcome.evidence_provenance;
    if (!Array.isArray(provenance) || provenance.length === 0) {
      errors.push("REQUIRED_EVIDENCE_PROVENANCE_MISSING");
      return errors;
    }

    for (const execId of provenance) {
      if (typeof execId !== "string" || execId.trim().length === 0) {
        errors.push(`INVALID_EVIDENCE_PROVENANCE_ID: ${execId}`);
        continue;
      }

      let found = false;

      // 1. Check in event stream
      if (Array.isArray(allEvents)) {
        for (const ev of allEvents) {
          if (ev && typeof ev === "object") {
            if (
              ev.execution_id === execId ||
              ev.executionId === execId ||
              ev.id === execId
            ) {
              found = true;
              break;
            }
          }
        }
      }

      // 2. Check on disk under .agents/state/executions/
      if (!found && repoRoot) {
        const execPath = join(
          repoRoot,
          ".agents",
          "state",
          "executions",
          `${execId}.json`,
        );
        if (existsSync(execPath)) {
          found = true;
        }
      }

      if (!found && repoRoot) {
        errors.push(`EVIDENCE_PROVENANCE_EXECUTION_ABSENT: ${execId}`);
      }
    }
  }

  return errors;
}

/**
 * Normalizes input events: accepts an array of strings (from events.jsonl)
 * or parsed event objects, or reads from repoRoot/.agents/telemetry/events.jsonl.
 *
 * @param {Array<unknown> | undefined} eventsInput
 * @param {string | undefined} repoRoot
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeEvents(eventsInput, repoRoot) {
  let rawEvents = eventsInput;

  if (!rawEvents && repoRoot) {
    const telemetryPath = join(repoRoot, ".agents", "telemetry", "events.jsonl");
    if (existsSync(telemetryPath)) {
      try {
        const content = readFileSync(telemetryPath, "utf8");
        rawEvents = content.trim().split("\n").filter(Boolean);
      } catch {
        rawEvents = [];
      }
    }
  }

  if (!Array.isArray(rawEvents)) {
    return [];
  }

  const parsed = [];
  for (const item of rawEvents) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) {
        try {
          parsed.push(JSON.parse(trimmed));
        } catch {}
      }
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      parsed.push(item);
    }
  }
  return parsed;
}

/**
 * Seals a factual world record from an event stream after verifying schema,
 * causal pairing, actor identity, event hashes, runtime fingerprints, and evidence correlation.
 *
 * @param {{
 *   events?: Array<unknown>,
 *   expectedRuntimeFingerprint?: string | Record<string, unknown>,
 *   repoRoot?: string,
 *   rootSnapshotId?: string,
 *   worldId?: string,
 * }} options
 * @returns {{
 *   status: "SEALED" | "WORLD_INCOMPLETE" | "WORLD_INVALID",
 *   world?: Record<string, unknown>,
 *   errors: string[],
 * }}
 */
export function sealWorld({
  events: eventsInput,
  expectedRuntimeFingerprint,
  repoRoot,
  rootSnapshotId,
  worldId,
} = {}) {
  const events = normalizeEvents(eventsInput, repoRoot);

  const decisions = [];
  const outcomes = [];
  const snapshots = [];

  for (const ev of events) {
    if (ev.type === "DECISION" || ev.schema === DREAM_SCHEMAS.DECISION) {
      decisions.push(ev);
    } else if (
      ev.type === "DECISION_OUTCOME" ||
      ev.schema === DREAM_SCHEMAS.OUTCOME
    ) {
      outcomes.push(ev);
    } else if (
      ev.type === "SNAPSHOT" ||
      ev.schema === DREAM_SCHEMAS.SNAPSHOT
    ) {
      snapshots.push(ev);
    }
  }

  if (decisions.length === 0 && outcomes.length === 0) {
    return {
      status: "WORLD_INCOMPLETE",
      errors: ["NO_DECISIONS_FOUND"],
    };
  }

  const invalidErrors = [];
  const incompleteErrors = [];

  // 1. Validate each DECISION event
  for (const dec of decisions) {
    const val = validateDreamRecord(DREAM_SCHEMAS.DECISION, dec);
    if (!val.valid) {
      invalidErrors.push(...val.errors);
    }

    if (!verifyEventHash(dec)) {
      invalidErrors.push(`TAMPERED_EVENT_HASH: ${dec.decision_id || dec.event_hash}`);
    }

    if (!isFactualActorIdentity(dec.actor_identity)) {
      invalidErrors.push("ROLE_IDENTITY_UNRESOLVED");
    }
  }

  // 2. Validate each DECISION_OUTCOME event
  for (const out of outcomes) {
    const val = validateDreamRecord(DREAM_SCHEMAS.OUTCOME, out);
    if (!val.valid) {
      invalidErrors.push(...val.errors);
    }

    if (!verifyEventHash(out)) {
      invalidErrors.push(`TAMPERED_EVENT_HASH: ${out.observation_id || out.event_hash}`);
    }

    const evErrors = checkEvidenceRequirement(out, repoRoot, events);
    if (evErrors.length > 0) {
      invalidErrors.push(...evErrors);
    }
  }

  // 3. Validate causal pairing between DECISION and DECISION_OUTCOME
  const decisionMap = new Map();
  for (const dec of decisions) {
    if (decisionMap.has(dec.decision_id)) {
      invalidErrors.push(`DUPLICATE_DECISION_ID: ${dec.decision_id}`);
    } else {
      decisionMap.set(dec.decision_id, dec);
    }
  }

  const outcomeMap = new Map();
  for (const out of outcomes) {
    if (!out.decision_id || !decisionMap.has(out.decision_id)) {
      invalidErrors.push("ORPHAN_OR_MISMATCHED_OUTCOME");
    }
    if (outcomeMap.has(out.decision_id)) {
      invalidErrors.push(`DUPLICATE_OUTCOME_FOR_DECISION: ${out.decision_id}`);
    } else {
      outcomeMap.set(out.decision_id, out);
    }
  }

  for (const dec of decisions) {
    if (!outcomeMap.has(dec.decision_id)) {
      incompleteErrors.push("OPEN_DECISION_WITHOUT_OUTCOME");
    }
  }

  // 4. Validate runtime fingerprint consistency
  let resolvedRuntimeFp = expectedRuntimeFingerprint;

  for (const snap of snapshots) {
    const snapVal = validateDreamRecord(DREAM_SCHEMAS.SNAPSHOT, snap);
    if (!snapVal.valid) {
      invalidErrors.push(...snapVal.errors);
    }
    if (snap.runtime_fingerprint) {
      if (
        expectedRuntimeFingerprint &&
        JSON.stringify(snap.runtime_fingerprint) !==
          JSON.stringify(expectedRuntimeFingerprint)
      ) {
        invalidErrors.push("RUNTIME_FINGERPRINT_MISMATCH");
      }
      if (!resolvedRuntimeFp) {
        resolvedRuntimeFp = snap.runtime_fingerprint;
      } else if (
        JSON.stringify(resolvedRuntimeFp) !==
        JSON.stringify(snap.runtime_fingerprint)
      ) {
        invalidErrors.push("RUNTIME_FINGERPRINT_INCONSISTENCY");
      }
    }
  }

  // 5. Resolve root_snapshot_id
  const resolvedRootSnapshotId =
    rootSnapshotId ||
    snapshots[0]?.snapshot_id ||
    decisions[0]?.snapshot_id;

  if (!resolvedRootSnapshotId) {
    invalidErrors.push("MISSING_ROOT_SNAPSHOT_ID");
  }

  if (!resolvedRuntimeFp) {
    invalidErrors.push("MISSING_RUNTIME_FINGERPRINT");
  }

  // Determine terminal status
  if (invalidErrors.length > 0) {
    return {
      status: "WORLD_INVALID",
      errors: invalidErrors,
    };
  }

  if (incompleteErrors.length > 0) {
    return {
      status: "WORLD_INCOMPLETE",
      errors: incompleteErrors,
    };
  }

  // 6. Sort events causally: DECISION followed by its OUTCOME, stable tie-break by step_idx / created_at / decision_id
  const sortedDecisions = [...decisions].sort((a, b) => {
    const stepA = Number(a.step_idx ?? 0);
    const stepB = Number(b.step_idx ?? 0);
    if (stepA !== stepB) return stepA - stepB;

    const timeA = String(a.created_at ?? "");
    const timeB = String(b.created_at ?? "");
    if (timeA !== timeB) return timeA.localeCompare(timeB);

    const ordA = Number(a.branch_ordinal ?? 0);
    const ordB = Number(b.branch_ordinal ?? 0);
    if (ordA !== ordB) return ordA - ordB;

    return String(a.decision_id ?? "").localeCompare(String(b.decision_id ?? ""));
  });

  const orderedDecisions = [];
  const orderedOutcomes = [];
  const orderedEvents = [];

  for (const dec of sortedDecisions) {
    const matchingOut = outcomeMap.get(dec.decision_id);
    orderedDecisions.push(dec);
    orderedOutcomes.push(matchingOut);
    orderedEvents.push(dec, matchingOut);
  }

  const event_hashes = orderedEvents.map((e) => e.event_hash);

  const manifestPayload = {
    schema: DREAM_SCHEMAS.WORLD,
    root_snapshot_id: resolvedRootSnapshotId,
    runtime_fingerprint: resolvedRuntimeFp,
    event_hashes,
  };

  const world_manifest_hash = sha256Canonical(manifestPayload);

  const generatedWorldId =
    worldId ||
    `world-${world_manifest_hash.slice(7, 23)}`;

  const world = {
    schema: DREAM_SCHEMAS.WORLD,
    world_id: generatedWorldId,
    root_snapshot_id: resolvedRootSnapshotId,
    runtime_fingerprint: resolvedRuntimeFp,
    event_hashes,
    world_manifest_hash,
    status: "SEALED",
    decisions: orderedDecisions,
    outcomes: orderedOutcomes,
    events: orderedEvents,
    created_at: new Date().toISOString(),
  };

  const worldValidation = validateDreamRecord(DREAM_SCHEMAS.WORLD, world);
  if (!worldValidation.valid) {
    return {
      status: "WORLD_INVALID",
      errors: worldValidation.errors,
    };
  }

  return {
    status: "SEALED",
    world,
    errors: [],
  };
}

/**
 * Pure validator verifying world record integrity and re-checking world_manifest_hash.
 *
 * @param {Record<string, unknown>} world
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateWorld(world) {
  if (!world || typeof world !== "object" || Array.isArray(world)) {
    return { valid: false, errors: ["World record must be a non-null object"] };
  }

  const schemaValidation = validateDreamRecord(DREAM_SCHEMAS.WORLD, world);
  if (!schemaValidation.valid) {
    return { valid: false, errors: schemaValidation.errors };
  }

  if (world.status !== "SEALED") {
    return {
      valid: false,
      errors: [`Invalid world status for sealed validation: ${world.status}`],
    };
  }

  const errors = [];

  const expectedManifestHash = sha256Canonical({
    schema: DREAM_SCHEMAS.WORLD,
    root_snapshot_id: world.root_snapshot_id,
    runtime_fingerprint: world.runtime_fingerprint,
    event_hashes: world.event_hashes,
  });

  if (world.world_manifest_hash !== expectedManifestHash) {
    errors.push(
      `WORLD_MANIFEST_HASH_MISMATCH: expected "${expectedManifestHash}", got "${world.world_manifest_hash}"`
    );
  }

  const events = Array.isArray(world.events) ? world.events : [];
  const decisions = Array.isArray(world.decisions) ? world.decisions : [];
  const outcomes = Array.isArray(world.outcomes) ? world.outcomes : [];
  const manifestEventHashes = Array.isArray(world.event_hashes) ? world.event_hashes : [];

  if (events.length !== manifestEventHashes.length) {
    errors.push(
      `WORLD_EVENT_COUNT_MISMATCH: events=${events.length}, event_hashes=${manifestEventHashes.length}`
    );
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!verifyEventHash(event)) {
      errors.push(`TAMPERED_WORLD_EVENT_HASH: index=${i}`);
      continue;
    }
    if (manifestEventHashes[i] !== event.event_hash) {
      errors.push(
        `WORLD_EVENT_HASH_ORDER_MISMATCH: index=${i}, expected="${manifestEventHashes[i]}", got="${event.event_hash}"`
      );
    }
  }

  const eventDecisions = events.filter(
    (ev) => ev?.type === "DECISION" || ev?.schema === DREAM_SCHEMAS.DECISION
  );
  const eventOutcomes = events.filter(
    (ev) => ev?.type === "DECISION_OUTCOME" || ev?.schema === DREAM_SCHEMAS.OUTCOME
  );

  if (decisions.length !== eventDecisions.length) {
    errors.push(
      `WORLD_DECISION_PROJECTION_COUNT_MISMATCH: decisions=${decisions.length}, event_decisions=${eventDecisions.length}`
    );
  }
  if (outcomes.length !== eventOutcomes.length) {
    errors.push(
      `WORLD_OUTCOME_PROJECTION_COUNT_MISMATCH: outcomes=${outcomes.length}, event_outcomes=${eventOutcomes.length}`
    );
  }

  const compareProjection = (projection, projectedEvents, label) => {
    const count = Math.min(projection.length, projectedEvents.length);
    for (let i = 0; i < count; i++) {
      const record = projection[i];
      const event = projectedEvents[i];
      if (!verifyEventHash(record)) {
        errors.push(`TAMPERED_WORLD_${label}_HASH: index=${i}`);
        continue;
      }
      if (
        record.event_hash !== event.event_hash ||
        sha256Canonical(record) !== sha256Canonical(event)
      ) {
        errors.push(`WORLD_${label}_PROJECTION_MISMATCH: index=${i}`);
      }
    }
  };

  compareProjection(decisions, eventDecisions, "DECISION");
  compareProjection(outcomes, eventOutcomes, "OUTCOME");

  return { valid: errors.length === 0, errors };
}

/**
 * Persists a sealed world only under repoRoot/.agents/dream-data/worlds/.
 * Rejects unsealed, incomplete, or invalid worlds.
 *
 * @param {string} repoRoot
 * @param {Record<string, unknown>} world
 * @returns {{ written: boolean, path?: string, reason?: string, errors?: string[], error?: string }}
 */
export function writeSealedWorld(repoRoot, world) {
  if (!repoRoot || typeof repoRoot !== "string") {
    return { written: false, reason: "MISSING_REPO_ROOT" };
  }

  if (!world || world.status !== "SEALED") {
    return { written: false, reason: "WORLD_NOT_SEALED" };
  }

  const validation = validateWorld(world);
  if (!validation.valid) {
    return { written: false, reason: "WORLD_INVALID", errors: validation.errors };
  }

  try {
    const worldsDir = join(repoRoot, ".agents", "dream-data", "worlds");
    mkdirSync(worldsDir, { recursive: true });

    const targetFile = join(worldsDir, `${world.world_id}.json`);
    writeFileSync(targetFile, JSON.stringify(world, null, 2), "utf8");

    return { written: true, path: targetFile };
  } catch (err) {
    return { written: false, reason: "WRITE_FAILED", error: err.message };
  }
}
