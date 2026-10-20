#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGlobalProjectRegistry } from "../global/project-registry.mjs";
import { createLearnedPolicyStore } from "./policy-store.mjs";
import { trainNativeRsiCandidate } from "./native-pipeline.mjs";

function parse(argv) {
  const allowed = new Set(["--home", "--runtime-image", "--policy-id", "--revision"]);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!allowed.has(key) || typeof value !== "string" || !value || value.startsWith("--")
      || Object.hasOwn(options, key)) {
      throw new TypeError("RSI_NATIVE_TRAIN_USAGE");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 4
    || !/^[1-9][0-9]*$/.test(options["--revision"])
    || !Number.isSafeInteger(Number(options["--revision"]))) {
    throw new TypeError("RSI_NATIVE_TRAIN_USAGE");
  }
  return options;
}

export function executeNativeTraining({ argv, now = () => new Date().toISOString(), createRegistry = createGlobalProjectRegistry } = {}) {
  const args = parse(argv);
  const registry = createRegistry({ home: args["--home"] });
  try {
    if (!registry?.state?.nativeRsi) {
      return { ok: false, code: "RSI_NATIVE_STORE_UNAVAILABLE" };
    }
    const policyStore = createLearnedPolicyStore({ persistence: registry.state.learnedPolicies });
    const revision = Number(args["--revision"]);
    const policyId = args["--policy-id"];
    const previous = policyStore.inspect(policyId, revision);
    const trained = trainNativeRsiCandidate({
      nativeStore: registry.state.nativeRsi,
      policyStore,
      policyId,
      revision,
      createdAt: previous?.createdAt ?? now(),
      runtimeImageId: args["--runtime-image"],
    });
    if (!trained.ok) return { ok: false, code: trained.code || "RSI_NATIVE_TRAINING_FAILED" };
    // Keep private Project / Operation identities in Home. Output only safe refs.
    return {
      ok: true,
      code: "RSI_NATIVE_CANDIDATE_TRAINED",
      policyId,
      revision,
      runtimeImageId: args["--runtime-image"],
      sourceDigest: trained.sourceDigest,
      receiptRef: trained.receiptRef,
      lineageCount: trained.lineageCount,
    };
  } finally {
    registry.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = executeNativeTraining({ argv: process.argv.slice(2) });
    process.stdout.write(JSON.stringify(output) + "\n");
    if (!output.ok) process.exitCode = 1;
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, code: "RSI_NATIVE_TRAIN_FAILED" }) + "\n");
    process.exitCode = 1;
  }
}
