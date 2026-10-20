import { createHash } from "node:crypto";
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

export function createNativeRsiObservationStore({ dbPath, state, now = () => new Date().toISOString() } = {}) {
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
        outcome: { success: terminal.workflowState === "SUCCEEDED", retryCount: 0, durationMs: terminal.durationMs },
        privacy: { containsRawProjectContent: false },
        evidence: { choiceRef: row.decision_digest, outcomeRef: row.terminal_digest },
      };
    }

    return Object.freeze({
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
      listObserved() {
        assertOpen();
        const observations = [];
        for (const row of all.all()) {
          const item = verified(row);
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
          ["candidateDigest", "policyId", "revision", "seed", "sourceDigest", "trainLineageIds"].sort().join(",")
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
