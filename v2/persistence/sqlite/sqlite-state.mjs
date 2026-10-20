import { createInMemoryRecoveryJournal } from "../../reconciliation/recovery-journal.mjs";
import { fenceOperationsToActiveWork } from "../../state/active-work-operation-fence.mjs";
import { trackOperationListing } from "../../state/operation-listing.mjs";
import { createSqliteExperiencePersistence } from "./sqlite-experience.mjs";
import { createSqliteLearnedPolicyPersistence } from "./sqlite-learned-policies.mjs";
import { createNativeRsiObservationStore } from "./sqlite-rsi-native.mjs";
import { fenceSqliteOperationTerminalization } from "./sqlite-operation-terminalization-fence.mjs";
import { withSqliteProjectRuntimeUpdates } from "./sqlite-project-runtime.mjs";
import { createSqliteRecoveryJournal } from "./sqlite-recovery-journal.mjs";
import { createSqliteState as createSqliteStateCore } from "./sqlite-state-core.mjs";

export { createSqliteRuntimeImageRegistry } from "./sqlite-runtime-images.mjs";

function createUnavailableExperiencePersistence(cause) {
  function unavailable() {
    const error = new Error("ORCHESTRA_EXPERIENCE_STORE_UNAVAILABLE");
    error.code = "ORCHESTRA_EXPERIENCE_STORE_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }

  return Object.freeze({
    put: unavailable,
    inspect: unavailable,
    list: unavailable,
    query: unavailable,
    close() {},
  });
}

function createUnavailableLearnedPolicyPersistence(cause) {
  function unavailable() {
    const error = new Error("ORCHESTRA_RSI_POLICY_STORE_UNAVAILABLE");
    error.code = "ORCHESTRA_RSI_POLICY_STORE_UNAVAILABLE";
    error.cause = cause;
    throw error;
  }

  return Object.freeze({
    putCandidate: unavailable,
    inspect: unavailable,
    activate: unavailable,
    active: unavailable,
    history: unavailable,
    close() {},
  });
}

export function createSqliteState(options = {}) {
  const listed = trackOperationListing(createSqliteStateCore(options));
  const runtimeMutable = withSqliteProjectRuntimeUpdates(listed, {
    dbPath: options.dbPath,
    timeoutMs: options.timeoutMs,
  });
  const activeWorkFenced = fenceOperationsToActiveWork(runtimeMutable);
  const core = fenceSqliteOperationTerminalization(activeWorkFenced, {
    dbPath: options.dbPath,
    timeoutMs: options.timeoutMs,
  });

  let recoveries;
  try {
    recoveries = options.dbPath === ":memory:"
      ? createInMemoryRecoveryJournal({ state: core })
      : createSqliteRecoveryJournal({
        dbPath: options.dbPath,
        state: core,
        timeoutMs: options.timeoutMs,
      });
  } catch (error) {
    core.close();
    throw error;
  }

  let experience;
  try {
    experience = createSqliteExperiencePersistence({
      dbPath: options.dbPath,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    experience = createUnavailableExperiencePersistence(error);
  }

  let learnedPolicies;
  try {
    learnedPolicies = createSqliteLearnedPolicyPersistence({
      dbPath: options.dbPath,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    learnedPolicies = createUnavailableLearnedPolicyPersistence(error);
  }

  // Non-authoritative learning telemetry never blocks Work/Operation authority.
  // A missing store means no RSI evidence, not an implied positive outcome.
  let nativeRsi = null;
  try {
    nativeRsi = createNativeRsiObservationStore({
      dbPath: options.dbPath,
      state: core,
    });
  } catch {
    nativeRsi = null;
  }

  let closed = false;
  return Object.freeze({
    ...core,
    recoveries,
    experience,
    learnedPolicies,
    nativeRsi,
    close() {
      if (closed) return;
      nativeRsi?.close();
      learnedPolicies.close?.();
      experience.close?.();
      recoveries.close?.();
      core.close();
      closed = true;
    },
  });
}