import { validateExperienceRecord } from "./contracts.mjs";

function requirePersistence(persistence) {
  if (!persistence || typeof persistence.put !== "function"
    || typeof persistence.inspect !== "function" || typeof persistence.list !== "function") {
    throw new TypeError("Experience persistence with put/inspect/list is required");
  }
  return persistence;
}

function assertValid(record) {
  const validation = validateExperienceRecord(record);
  if (!validation.valid) {
    const error = new TypeError(`invalid Experience record: ${validation.errors[0]?.message ?? "unknown error"}`);
    error.code = "ORCHESTRA_EXPERIENCE_INVALID";
    error.errors = validation.errors;
    throw error;
  }
}

export function createExperienceStore({ persistence } = {}) {
  const backing = requirePersistence(persistence);

  return Object.freeze({
    put(record) {
      assertValid(record);
      return backing.put(structuredClone(record));
    },

    inspect(experienceId) {
      const record = backing.inspect(experienceId);
      if (record !== null) assertValid(record);
      return record;
    },

    list() {
      const records = backing.list();
      for (const record of records) assertValid(record);
      return records;
    },
  });
}
