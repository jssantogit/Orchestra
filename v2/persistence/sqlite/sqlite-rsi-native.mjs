import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Separate v2 Home-owned, append-only observation boundary. An observation is
// never accepted from provider payloads or caller-authored candidate selectors.
// It re-reads authoritative Project / Work / Operation / provider correlation.
const PROVIDERS = new Set(["codex", "antigravity"]);
const REF = /^sha256:[0-9a-f]{64}$/;

function fail(code) {
  return { ok: false, code };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

function encode(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return "sha256:" + createHash("sha256").update(encode(value), "utf8").digest("hex");
}

function safelyRead(value, expectedDigest) {
  const parsed = JSON.parse(value);
  if (digest(parsed) !== expectedDigest || encode(parsed) !== value) {
    throw new Error("ORCHESTRA_RSI_NATIVE_RECEIPT_CORRUPT");
  }
  return parsed;
}

function validateSource(state, operationId, providerFamily, correlationHash) {
  const operation = state.operations.inspect(operationId);
  if (!operation || operation.kind !== "DIRECT_MUTATION"
    || !operation.capabilities?.includes("WORKSPACE_EDIT")) return null;
  const project = state.projects.inspect(operation.projectId);
  const work = state.work.read(operation.projectId, operation.workId);
  if (!project || !work || work.workId !== operation.workId
    || work.generation !== operation.generation
    || work.runtimeImage !== project.runtime?.pinnedImage
    || typeof project.lineageId !== "string" || !project.lineageId) return null;
  const correlation = state.operationCorrelations.get({
    provider: providerFamily, projectId: operation.projectId, correlationHash,
  });
  if (!correlation || Array.isArray(correlation)
    || correlation.provider !== providerFamily
    || correlation.projectId !== operation.projectId
    || correlation.correlationHash !== correlationHash
    || correlation.operationId !== operationId
    || correlation.workId !== operation.workId
    || correlation.generation !== operation.generation
    || correlation.actorIdHash !== operation.actorRef) return null;
  return { project, work, operation };
}

const DELEGATED_CHOICE = Object.freeze(["DIRECT_WORK", "DELEGATED"]);
const BLOB_LIMIT = 8 * 1024 * 1024;

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function delegatedSource(state, operationId) {
  const operation = state.operations.inspect(operationId);
  if (!operation || operation.kind !== "DELEGATED_MUTATION"
    || operation.capabilities?.length !== 1
    || operation.capabilities[0] !== "WORKSPACE_EDIT") return null;
  const project = state.projects.inspect(operation.projectId);
  const work = state.work.read(operation.projectId, operation.workId);
  if (!project || !work || work.workId !== operation.workId
    || work.generation !== operation.generation
    || work.runtimeImage !== project.runtime?.pinnedImage
    || operation.workspaceRef !== project.workspace.canonicalRoot
    || typeof project.lineageId !== "string" || !project.lineageId) return null;
  return { project, work, operation };
}

// A content-addressed Home artifact is meaningful only if the exact local bytes
// still exist and the bounded mutation manifest itself re-hashes correctly.
// This never trusts worker report summaries or provider-claimed success.
function verifiedDelegatedArtifact(blobRoot, ref, decision) {
  if (!REF.test(ref) || typeof blobRoot !== "string" || !blobRoot) return false;
  const hex = ref.slice(7);
  let bytes, candidate;
  try {
    bytes = readFileSync(join(blobRoot, "sha256", hex.slice(0, 2), hex.slice(2)));
    if (bytes.length === 0 || bytes.length > BLOB_LIMIT
      || "sha256:" + createHash("sha256").update(bytes).digest("hex") !== ref) return false;
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch { return false; }
  if (!exactKeys(candidate, [
    "schema", "version", "projectId", "workId", "generation", "operationId",
    "runtimeImageId", "delegationId", "targetProvider", "sourceRevision",
    "sourceFingerprint", "mutationDigest", "files",
  ]) || candidate.schema !== "orchestra.v2-delegation-candidate.v1"
    || candidate.version !== 1 || candidate.operationId !== decision.operationId
    || candidate.projectId !== decision.projectId
    || candidate.workId !== decision.workId
    || candidate.generation !== decision.generation
    || candidate.runtimeImageId !== decision.runtimeImageId
    || candidate.targetProvider !== decision.targetProvider
    || !REF.test(candidate.mutationDigest)
    || !Array.isArray(candidate.files) || candidate.files.length < 1
    || candidate.files.length > 128) return false;
  const facts = [];
  for (const file of candidate.files) {
    if (!exactKeys(file, ["path", "kind", "mode", "contentHash", "bytesBase64"])
      || typeof file.path !== "string" || !file.path
      || typeof file.mode !== "string") return false;
    const { bytesBase64, ...fact } = file;
    if (file.kind === "DELETED") {
      if (bytesBase64 !== null || file.contentHash !== null) return false;
    } else if (file.kind === "FILE") {
      if (typeof bytesBase64 !== "string" || !REF.test(file.contentHash)) return false;
      const content = Buffer.from(bytesBase64, "base64");
      if (content.length > 2 * 1024 * 1024
        || content.toString("base64") !== bytesBase64
        || "sha256:" + createHash("sha256").update(content).digest("hex") !== file.contentHash) return false;
    } else return false;
    facts.push(fact);
  }
  if (new Set(facts.map((item) => item.path)).size !== facts.length) return false;
  if (JSON.stringify(facts.map((item) => item.path)) !== JSON.stringify(
    [...facts.map((item) => item.path)].sort())) return false;
  return "sha256:" + createHash("sha256").update(JSON.stringify(facts)).digest("hex")
    === candidate.mutationDigest;
}

export function createNativeRsiObservationStore({ dbPath, state, blobRoot = null, now = () => new Date().toISOString() } = {}) {
  if (typeof dbPath !== "string" || !dbPath
    || !state?.projects?.inspect || !state?.work?.read
    || !state?.operations?.inspect || !state?.operationCorrelations?.get) {
    throw new TypeError("native RSI requires Home SQLite and factual state");
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS rsi_native_observations (
      operation_id TEXT PRIMARY KEY,
      decision_json TEXT NOT NULL,
      decision_digest TEXT NOT NULL,
      terminal_json TEXT,
      terminal_digest TEXT,
      CHECK ((terminal_json IS NULL) = (terminal_digest IS NULL))
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS rsi_native_delegated (
      operation_id TEXT PRIMARY KEY,
      decision_json TEXT NOT NULL,
      decision_digest TEXT NOT NULL,
      terminal_json TEXT,
      terminal_digest TEXT,
      CHECK ((terminal_json IS NULL) = (terminal_digest IS NULL))
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS rsi_native_training (
      policy_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      receipt_json TEXT NOT NULL,
      receipt_digest TEXT NOT NULL,
      PRIMARY KEY (policy_id, revision)
    ) STRICT`);
    const trainingGet = db.prepare(
      "SELECT * FROM rsi_native_training WHERE policy_id=? AND revision=?",
    );
    const trainingInsert = db.prepare(
      "INSERT INTO rsi_native_training(policy_id,revision,receipt_json,receipt_digest) VALUES(?,?,?,?)",
    );
    const get = db.prepare("SELECT * FROM rsi_native_observations WHERE operation_id = ?");
    const all = db.prepare("SELECT * FROM rsi_native_observations ORDER BY operation_id");
    const insert = db.prepare(
      "INSERT INTO rsi_native_observations(operation_id,decision_json,decision_digest) VALUES(?,?,?)",
    );
    const finish = db.prepare(
      "UPDATE rsi_native_observations SET terminal_json=?,terminal_digest=? WHERE operation_id=? AND terminal_json IS NULL",
    );
    const delegatedGet = db.prepare("SELECT * FROM rsi_native_delegated WHERE operation_id=?");
    const delegatedAll = db.prepare("SELECT * FROM rsi_native_delegated ORDER BY operation_id");
    const delegatedInsert = db.prepare(
      "INSERT INTO rsi_native_delegated(operation_id,decision_json,decision_digest) VALUES(?,?,?)",
    );
    const delegatedFinish = db.prepare(
      "UPDATE rsi_native_delegated SET terminal_json=?,terminal_digest=? WHERE operation_id=? AND terminal_json IS NULL",
    );
    const nativeBlobRoot = blobRoot === null
      ? dbPath === ":memory:" ? null : resolve(dirname(dbPath), "..", "blobs")
      : resolve(blobRoot);
    let closed = false;
    function assertOpen() {
      if (closed) throw new Error("ORCHESTRA_RSI_NATIVE_STORE_CLOSED");
    }
    function read(row) {
      if (!row) return null;
      const decision = safelyRead(row.decision_json, row.decision_digest);
      const terminal = row.terminal_json === null
        ? null : safelyRead(row.terminal_json, row.terminal_digest);
      if (decision.operationId !== row.operation_id
        || (terminal && terminal.operationId !== row.operation_id)) {
        throw new Error("ORCHESTRA_RSI_NATIVE_IDENTITY_CORRUPT");
      }
      return { decision, terminal };
    }
    function verified(row) {
      const receipt = read(row);
      if (!receipt?.terminal) return null;
      const { decision, terminal } = receipt;
      const source = validateSource(
        state, decision.operationId, decision.providerFamily, decision.correlationHash,
      );
      const operation = source?.operation;
      if (!source || source.project.lineageId !== decision.lineageId
        || source.work.runtimeImage !== decision.runtimeImageId
        || operation.workId !== decision.workId
        || operation.generation !== decision.generation
        || operation.startedAt !== decision.startedAt
        || operation.workflowState !== terminal.workflowState
        || operation.resultRef !== terminal.resultRef
        || operation.liveness !== "TERMINAL"
        || !["SUCCEEDED", "FAILED"].includes(terminal.workflowState)
        || terminal.resultRef !== `provider-result:${terminal.workflowState.toLowerCase()}:${decision.correlationHash}`
        || decision.selectedRoute !== "DIRECT_WORK"
        || decision.domainCohort !== "software-engineering"
        || terminal.durationMs < 0 || !Number.isSafeInteger(terminal.durationMs)
        || !REF.test(row.decision_digest) || !REF.test(row.terminal_digest)) return null;
      return {
        schema: "orchestra.rsi-decision-outcome.v1",
        version: 1,
        phase: "TRAIN",
        source: { lineageId: decision.lineageId, operationId: decision.operationId },
        domainCohort: decision.domainCohort,
        decision: {
          immutableRoutes: ["DIRECT_WORK"],
          legalRoutes: ["DIRECT_WORK"],
          selectedRoute: "DIRECT_WORK",
        },
        outcome: { success: terminal.workflowState === "SUCCEEDED", durationMs: terminal.durationMs },
        privacy: { containsRawProjectContent: false },
        evidence: { choiceRef: row.decision_digest, outcomeRef: row.terminal_digest },
      };
    }

    function delegatedRead(row) {
      if (!row) return null;
      const decision = safelyRead(row.decision_json, row.decision_digest);
      const terminal = row.terminal_json === null
        ? null : safelyRead(row.terminal_json, row.terminal_digest);
      if (decision.operationId !== row.operation_id
        || terminal?.operationId !== row.operation_id) {
        throw new Error("ORCHESTRA_RSI_NATIVE_DELEGATED_IDENTITY_CORRUPT");
      }
      return { decision, terminal };
    }

    function verifiedDelegated(row) {
      const receipt = delegatedRead(row);
      if (!receipt?.terminal) return null;
      const { decision, terminal } = receipt;
      const source = delegatedSource(state, decision.operationId);
      const op = source?.operation;
      const artifactRef = typeof terminal.resultRef === "string"
        && terminal.resultRef.startsWith("delegation-artifact:")
          ? terminal.resultRef.slice("delegation-artifact:".length) : null;
      if (!source || !op || source.project.lineageId !== decision.lineageId
        || source.work.runtimeImage !== decision.runtimeImageId
        || op.actorRef !== decision.actorRef
        || op.startedAt !== decision.startedAt
        || op.workflowState !== "SUCCEEDED" || op.liveness !== "TERMINAL"
        || op.resultRef !== terminal.resultRef || terminal.workflowState !== "SUCCEEDED"
        || decision.selectedRoute !== "DELEGATED"
        || decision.domainCohort !== "software-engineering"
        || !PROVIDERS.has(decision.sourceProvider)
        || !PROVIDERS.has(decision.targetProvider)
        || decision.sourceProvider === decision.targetProvider
        || !Array.isArray(decision.legalRoutes)
        || JSON.stringify(decision.legalRoutes) !== JSON.stringify(DELEGATED_CHOICE)
        || !Number.isSafeInteger(terminal.durationMs) || terminal.durationMs < 0
        || !REF.test(row.decision_digest) || !REF.test(row.terminal_digest)
        || !verifiedDelegatedArtifact(nativeBlobRoot, artifactRef, decision)) return null;
      return {
        schema: "orchestra.rsi-decision-outcome.v1", version: 1, phase: "TRAIN",
        source: { lineageId: decision.lineageId, operationId: decision.operationId },
        domainCohort: decision.domainCohort,
        decision: {
          immutableRoutes: [...DELEGATED_CHOICE], legalRoutes: [...DELEGATED_CHOICE],
          selectedRoute: "DELEGATED",
        },
        outcome: { success: true, durationMs: terminal.durationMs },
        privacy: { containsRawProjectContent: false },
        evidence: { choiceRef: row.decision_digest, outcomeRef: row.terminal_digest },
      };
    }

    return Object.freeze({
      recordDelegatedDecision({ operationId, sourceProvider, targetProvider, providerVersion } = {}) {
        assertOpen();
        if (typeof operationId !== "string" || !operationId
          || !PROVIDERS.has(sourceProvider) || !PROVIDERS.has(targetProvider)
          || sourceProvider === targetProvider
          || typeof providerVersion !== "string" || !providerVersion
          || providerVersion.length > 128) return fail("RSI_NATIVE_DELEGATED_DECISION_INVALID");
        const source = delegatedSource(state, operationId);
        const op = source?.operation;
        const session = source && state.sessionObservations?.get({
          provider: sourceProvider, projectId: source.project.projectId, actorIdHash: op.actorRef,
        });
        if (!source || op.workflowState !== "RUNNING" || op.liveness !== "LIVE"
          || !session || session.observedWorkId !== op.workId
          || session.observedGeneration !== op.generation
          || session.observedInstructionEpoch !== source.project.runtime.instructionEpoch
          || !Number.isFinite(Date.parse(session.observedAt))) {
          return fail("RSI_NATIVE_DELEGATED_DECISION_UNVERIFIED");
        }
        const decision = {
          schema: "orchestra.rsi-native-delegated-decision.v1", version: 1,
          operationId, projectId: source.project.projectId,
          lineageId: source.project.lineageId,
          workId: op.workId, generation: op.generation,
          runtimeImageId: source.work.runtimeImage, actorRef: op.actorRef,
          sourceProvider, targetProvider, providerVersion,
          startedAt: op.startedAt, domainCohort: "software-engineering",
          legalRoutes: [...DELEGATED_CHOICE], selectedRoute: "DELEGATED",
        };
        const json = encode(decision), ref = digest(decision);
        const old = delegatedGet.get(operationId);
        if (old) {
          delegatedRead(old);
          return old.decision_json === json && old.decision_digest === ref
            ? { ok: true, replayed: true, choiceRef: ref }
            : fail("RSI_NATIVE_DELEGATED_DECISION_CONFLICT");
        }
        delegatedInsert.run(operationId, json, ref);
        return { ok: true, replayed: false, choiceRef: ref };
      },
      recordDelegatedTerminal({ operationId } = {}) {
        assertOpen();
        const row = delegatedGet.get(operationId);
        if (!row) return fail("RSI_NATIVE_DELEGATED_DECISION_MISSING");
        const receipt = delegatedRead(row);
        const { decision } = receipt;
        const source = delegatedSource(state, operationId);
        const op = source?.operation;
        const ref = op?.resultRef?.startsWith("delegation-artifact:")
          ? op.resultRef.slice("delegation-artifact:".length) : null;
        if (!source || op.liveness !== "TERMINAL" || op.workflowState !== "SUCCEEDED"
          || source.project.lineageId !== decision.lineageId
          || source.work.runtimeImage !== decision.runtimeImageId
          || op.actorRef !== decision.actorRef || op.startedAt !== decision.startedAt
          || !verifiedDelegatedArtifact(nativeBlobRoot, ref, decision)) {
          return fail("RSI_NATIVE_DELEGATED_TERMINAL_UNVERIFIED");
        }
        if (receipt.terminal) {
          return receipt.terminal.resultRef === op.resultRef
            && receipt.terminal.workflowState === op.workflowState
            ? { ok: true, replayed: true, outcomeRef: row.terminal_digest }
            : fail("RSI_NATIVE_DELEGATED_TERMINAL_CONFLICT");
        }
        const elapsed = Date.parse(now()) - Date.parse(op.startedAt);
        if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
          return fail("RSI_NATIVE_DURATION_UNKNOWN");
        }
        const terminal = {
          schema: "orchestra.rsi-native-terminal.v1", version: 1,
          operationId, workflowState: "SUCCEEDED",
          resultRef: op.resultRef, durationMs: elapsed,
        };
        const json = encode(terminal), refDigest = digest(terminal);
        const updated = delegatedFinish.run(json, refDigest, operationId);
        if (updated.changes !== 1) return fail("RSI_NATIVE_DELEGATED_TERMINAL_RACE");
        return { ok: true, replayed: false, outcomeRef: refDigest };
      },
      recordDecision({ operationId, providerFamily, correlationHash } = {}) {
        assertOpen();
        if (typeof operationId !== "string" || !operationId
          || !PROVIDERS.has(providerFamily) || !REF.test(correlationHash)) {
          return fail("RSI_NATIVE_DECISION_INVALID");
        }
        const source = validateSource(state, operationId, providerFamily, correlationHash);
        if (!source || source.operation.workflowState !== "RUNNING"
          || source.operation.liveness !== "LIVE") return fail("RSI_NATIVE_DECISION_UNVERIFIED");
        const decision = {
          schema: "orchestra.rsi-native-decision.v1",
          version: 1,
          operationId,
          projectId: source.project.projectId,
          lineageId: source.project.lineageId,
          workId: source.operation.workId,
          generation: source.operation.generation,
          runtimeImageId: source.work.runtimeImage,
          providerFamily,
          correlationHash,
          startedAt: source.operation.startedAt,
          domainCohort: "software-engineering",
          selectedRoute: "DIRECT_WORK",
        };
        const json = encode(decision), ref = digest(decision);
        const existing = get.get(operationId);
        if (existing) {
          read(existing);
          return existing.decision_json === json && existing.decision_digest === ref
            ? { ok: true, replayed: true, choiceRef: ref }
            : fail("RSI_NATIVE_DECISION_CONFLICT");
        }
        insert.run(operationId, json, ref);
        return { ok: true, replayed: false, choiceRef: ref };
      },
      recordTerminal({ operationId } = {}) {
        assertOpen();
        const row = get.get(operationId);
        if (!row) return fail("RSI_NATIVE_DECISION_MISSING");
        const receipt = read(row);
        const decision = receipt.decision;
        const source = validateSource(state, operationId, decision.providerFamily, decision.correlationHash);
        const operation = source?.operation;
        if (!source || source.project.lineageId !== decision.lineageId
          || source.work.runtimeImage !== decision.runtimeImageId
          || operation.startedAt !== decision.startedAt
          || operation.liveness !== "TERMINAL"
          || !["SUCCEEDED", "FAILED"].includes(operation.workflowState)
          || operation.resultRef !== `provider-result:${operation.workflowState.toLowerCase()}:${decision.correlationHash}`) {
          return fail("RSI_NATIVE_TERMINAL_UNVERIFIED");
        }
        if (receipt.terminal) {
          return receipt.terminal.resultRef === operation.resultRef
            && receipt.terminal.workflowState === operation.workflowState
            ? { ok: true, replayed: true, outcomeRef: row.terminal_digest }
            : fail("RSI_NATIVE_TERMINAL_CONFLICT");
        }
        const elapsed = Date.parse(now()) - Date.parse(operation.startedAt);
        if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
          return fail("RSI_NATIVE_DURATION_UNKNOWN");
        }
        const terminal = {
          schema: "orchestra.rsi-native-terminal.v1",
          version: 1,
          operationId,
          workflowState: operation.workflowState,
          resultRef: operation.resultRef,
          durationMs: elapsed,
        };
        const json = encode(terminal), ref = digest(terminal);
        const updated = finish.run(json, ref, operationId);
        if (updated.changes !== 1) return fail("RSI_NATIVE_TERMINAL_RACE");
        return { ok: true, replayed: false, outcomeRef: ref };
      },
      listObserved({ runtimeImageId = null } = {}) {
        assertOpen();
        if (runtimeImageId !== null && (typeof runtimeImageId !== "string" || !runtimeImageId)) {
          throw new TypeError("native RSI runtime image filter invalid");
        }
        const observations = [];
        for (const row of all.all()) {
          const receipt = read(row);
          if (runtimeImageId !== null && receipt?.decision.runtimeImageId !== runtimeImageId) continue;
          const item = verified(row);
          if (item) observations.push(item);
        }
        for (const row of delegatedAll.all()) {
          const receipt = delegatedRead(row);
          if (runtimeImageId !== null && receipt?.decision.runtimeImageId !== runtimeImageId) continue;
          const item = verifiedDelegated(row);
          if (item) observations.push(item);
        }
        return observations.sort((a, b) => a.source.lineageId.localeCompare(b.source.lineageId)
          || a.source.operationId.localeCompare(b.source.operationId));
      },
      listEligible() {
        return this.listObserved().filter((item) => item.outcome.success === true);
      },
      putTrainingReceipt(receipt) {
        assertOpen();
        if (!receipt || Object.keys(receipt).sort().join(",") !==
          ["schema", "version", "candidateDigest", "policyId", "revision", "seed", "sourceDigest", "trainLineageIds"].sort().join(",")
          || receipt.schema !== "orchestra.rsi-native-training.v1" || receipt.version !== 1
          || typeof receipt.policyId !== "string" || !receipt.policyId
          || !Number.isInteger(receipt.revision) || receipt.revision < 1
          || !REF.test(receipt.sourceDigest) || !REF.test(receipt.candidateDigest)
          || typeof receipt.seed !== "string" || !receipt.seed
          || !Array.isArray(receipt.trainLineageIds)
          || receipt.trainLineageIds.length < 2
          || !receipt.trainLineageIds.every((x) => typeof x === "string" && x)
          || new Set(receipt.trainLineageIds).size !== receipt.trainLineageIds.length) {
          return fail("RSI_NATIVE_TRAINING_RECEIPT_INVALID");
        }
        const json = encode(receipt), ref = digest(receipt);
        const existing = trainingGet.get(receipt.policyId, receipt.revision);
        if (existing) {
          safelyRead(existing.receipt_json, existing.receipt_digest);
          return existing.receipt_json === json && existing.receipt_digest === ref
            ? { ok: true, replayed: true, receiptRef: ref }
            : fail("RSI_NATIVE_TRAINING_RECEIPT_CONFLICT");
        }
        trainingInsert.run(receipt.policyId, receipt.revision, json, ref);
        return { ok: true, replayed: false, receiptRef: ref };
      },
      inspectTrainingReceipt(policyId, revision) {
        assertOpen();
        const existing = trainingGet.get(policyId, revision);
        return existing ? safelyRead(existing.receipt_json, existing.receipt_digest) : null;
      },
      close() {
        if (closed) return;
        db.close();
        closed = true;
      },
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
