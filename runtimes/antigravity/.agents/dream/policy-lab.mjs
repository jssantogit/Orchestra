import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { sha256Canonical } from "./canonical.mjs";
import { createReplayReport } from "./evaluator.mjs";
import { computePolicyId, evaluatePolicy, POLICY_STATUS, validatePolicy } from "./policy-engine.mjs";
import { replayExact } from "./replay-simulator.mjs";
import { validateWorld } from "./world-sealer.mjs";
import { loadRuntimePolicy } from "./policy-store.mjs";

export const POLICY_DATASET_SCHEMA = "orchestra.policy-development-dataset.v1";
export const POLICY_CYCLE_SCHEMA = "orchestra.policy-lab-cycle.v1";
export const POLICY_EVALUATION_SCHEMA = "orchestra.policy-lab-evaluation.v1";

export const POLICY_LAB_LIMITS = Object.freeze({
  train_percent: 80,
  holdout_percent: 20,
  max_structured_examples: 20,
  max_designer_calls: 2,
  max_candidates_per_call: 4,
  promotion_min_train_lineages: 100,
  promotion_min_holdout_lineages: 30,
});

const STATE_FIELDS = Object.freeze([
  "task_action",
  "task_domain",
  "criticality",
  "complexity",
  "state",
  "attempt",
  "retry_remaining",
  "retry_reason",
  "post_investigation",
  "evidence",
  "exploration_branches_started",
  "exploration_branches_active",
  "exploration_branches_remaining",
  "feedback_unknown",
  "feedback_observed",
  "feedback_supported",
  "feedback_falsified",
  "feedback_causal",
  "branch_feedback_status",
  "branch_invalid",
]);

const LAB_ROOT = ".agents/dream-data/policy-lab";
const WORLDS_ROOT = ".agents/dream-data/worlds";

function datasetHash(dataset) {
  const { dataset_id: _id, ...rest } = dataset || {};
  return "dataset-" + sha256Canonical(rest).slice(7);
}

function cycleHash(cycle) {
  const { state_hash: _hash, ...rest } = cycle || {};
  return sha256Canonical(rest);
}

function writeCycle(path, cycle) {
  const value = structuredClone(cycle);
  value.state_hash = cycleHash(value);
  atomicJson(path, value);
  return value;
}

function readCycle(repoRoot, cyclePath) {
  if (!repoRoot || !cyclePath) return { ok: false, reason: "INVALID_CYCLE_PATH" };
  const resolved = resolve(cyclePath);
  const cyclesRoot = resolve(repoRoot, LAB_ROOT, "cycles");
  let parsed;
  try {
    parsed = readJson(resolved);
  } catch {
    return { ok: false, reason: "CYCLE_READ_FAILED" };
  }
  if (
    parsed?.schema !== POLICY_CYCLE_SCHEMA
    || typeof parsed?.cycle_id !== "string"
    || !/^cycle-[a-f0-9]{64}$/.test(parsed.cycle_id)
    || typeof parsed?.dataset_id !== "string"
    || !/^dataset-[a-f0-9]{64}$/.test(parsed.dataset_id)
  ) {
    return { ok: false, reason: "INVALID_CYCLE" };
  }
  const expectedPath = resolve(cyclesRoot, parsed.cycle_id + ".json");
  if (resolved !== expectedPath) return { ok: false, reason: "CYCLE_PATH_ESCAPE" };
  if (parsed.state_hash !== cycleHash(parsed)) {
    return { ok: false, reason: "CYCLE_STATE_HASH_MISMATCH" };
  }
  if (
    !Array.isArray(parsed.designer_calls)
    || parsed.designer_calls.length > POLICY_LAB_LIMITS.max_designer_calls
    || !Array.isArray(parsed.candidates)
    || parsed.candidates[0]?.source !== "BASELINE"
    || parsed.candidates[0]?.policy_id !== parsed.baseline_policy_id
    || parsed.activation_allowed !== false
    || parsed.limits?.max_designer_calls !== POLICY_LAB_LIMITS.max_designer_calls
    || parsed.limits?.max_candidates_per_call !== POLICY_LAB_LIMITS.max_candidates_per_call
    || !["OPEN", "DESIGNER_PENDING", "EVALUATED"].includes(parsed.status)
  ) {
    return { ok: false, reason: "CYCLE_STATE_INVALID" };
  }
  for (let i = 0; i < parsed.designer_calls.length; i++) {
    const call = parsed.designer_calls[i];
    if (
      call?.call_index !== i + 1
      || typeof call?.packet_id !== "string"
      || !/^packet-[a-f0-9]{64}$/.test(call.packet_id)
      || !["PACKET_ISSUED", "SUBMITTED", "REJECTED"].includes(call.status)
    ) {
      return { ok: false, reason: "CYCLE_DESIGNER_CALL_INVALID" };
    }
    if (call.status === "PACKET_ISSUED" && i !== parsed.designer_calls.length - 1) {
      return { ok: false, reason: "CYCLE_DESIGNER_CALL_INVALID" };
    }
  }
  const pending = parsed.designer_calls.at(-1)?.status === "PACKET_ISSUED";
  if ((parsed.status === "DESIGNER_PENDING") !== pending) {
    return { ok: false, reason: "CYCLE_DESIGNER_PENDING_STATE_MISMATCH" };
  }
  return { ok: true, cycle: parsed, path: resolved };
}

function validateDatasetIntegrity(dataset) {
  if (
    dataset?.schema !== POLICY_DATASET_SCHEMA
    || typeof dataset?.dataset_id !== "string"
    || !/^dataset-[a-f0-9]{64}$/.test(dataset.dataset_id)
  ) {
    return { valid: false, reason: "INVALID_DATASET" };
  }
  if (datasetHash(dataset) !== dataset.dataset_id) {
    return { valid: false, reason: "DATASET_ID_MISMATCH" };
  }
  const policyValidation = validatePolicy(dataset.current_policy);
  if (!policyValidation.valid) {
    return { valid: false, reason: "CURRENT_POLICY_INVALID", errors: policyValidation.errors };
  }
  return { valid: true };
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + process.pid + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  renameSync(temp, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sortedObject(input = {}) {
  const out = {};
  for (const key of Object.keys(input).sort()) out[key] = input[key];
  return out;
}

function increment(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.floor((sorted.length - 1) * q);
  return sorted[index];
}

function sanitizeState(state = {}) {
  const out = {};
  for (const key of STATE_FIELDS) {
    if (!(key in state)) continue;
    if (key === "evidence") {
      const evidence = state.evidence;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) continue;
      out.evidence = {};
      for (const evKey of ["tests", "typecheck", "build", "scope_check", "validation_fresh"]) {
        if (evKey in evidence) out.evidence[evKey] = evidence[evKey];
      }
      continue;
    }
    out[key] = state[key];
  }
  return out;
}

function stateBucket(decision) {
  const state = sanitizeState(decision?.state || {});
  const descriptor = {
    decision_type: String(decision?.decision_type || "UNKNOWN"),
    state,
  };
  return {
    bucket_id: "bucket-" + sha256Canonical(descriptor).slice(7, 23),
    decision_type: descriptor.decision_type,
    state,
  };
}

function lineageRef(lineageIdentity) {
  return "lineage-" + sha256Canonical({
    root_snapshot_id: lineageIdentity || null,
  }).slice(7, 23);
}

function worldSnapshotSet(world) {
  const snapshots = new Set();
  if (world?.root_snapshot_id) snapshots.add(world.root_snapshot_id);
  for (const decision of world?.decisions || []) {
    if (decision?.snapshot_id) snapshots.add(decision.snapshot_id);
  }
  for (const outcome of world?.outcomes || []) {
    if (outcome?.resulting_snapshot_id) snapshots.add(outcome.resulting_snapshot_id);
  }
  return snapshots;
}

export function deriveLineageAssignments(worlds = []) {
  const ordered = [...worlds].sort((a, b) =>
    String(a?.world_manifest_hash || "").localeCompare(String(b?.world_manifest_hash || ""))
  );
  const roots = [...new Set(ordered.map((world) => world?.root_snapshot_id).filter(Boolean))];
  const snapshotsByWorld = ordered.map((world) => worldSnapshotSet(world));
  const parentRoots = new Map(roots.map((root) => [root, new Set()]));

  for (const childRoot of roots) {
    for (let i = 0; i < ordered.length; i++) {
      const parentRoot = ordered[i]?.root_snapshot_id;
      if (!parentRoot || parentRoot === childRoot) continue;
      if (snapshotsByWorld[i].has(childRoot)) {
        parentRoots.get(childRoot).add(parentRoot);
      }
    }
  }

  function canonicalRoot(start) {
    const visited = new Set();
    const terminalRoots = new Set();
    const stack = [start];

    while (stack.length) {
      const node = stack.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);
      const parents = [...(parentRoots.get(node) || [])].sort();
      if (!parents.length) {
        terminalRoots.add(node);
        continue;
      }
      for (const parent of parents) stack.push(parent);
    }

    const roots = [...terminalRoots].sort();
    if (roots.length === 1) {
      return { root: roots[0], ambiguous: false, cycle: false, terminal_roots: roots };
    }
    if (roots.length > 1) {
      return { root: null, ambiguous: true, cycle: false, terminal_roots: roots };
    }
    return {
      root: null,
      ambiguous: true,
      cycle: visited.size > 0,
      terminal_roots: [],
    };
  }

  const assignments = new Map();
  for (const world of ordered) {
    const resolution = canonicalRoot(world.root_snapshot_id);
    const lineageRoot = resolution.root;
    assignments.set(world.world_manifest_hash, {
      lineage_root_snapshot_id: lineageRoot,
      lineage_ref: lineageRoot ? lineageRef(lineageRoot) : null,
      ambiguous: resolution.ambiguous,
      cycle: resolution.cycle,
      terminal_roots: resolution.terminal_roots,
      ...(lineageRoot ? splitLineage(lineageRoot) : { split: null, bucket: null }),
    });
  }
  return assignments;
}

export function splitLineage(lineageIdentity) {
  const hash = sha256Canonical({ lineage: String(lineageIdentity || "") }).slice(7);
  const bucket = Number.parseInt(hash.slice(0, 8), 16) % 100;
  return {
    split: bucket < POLICY_LAB_LIMITS.train_percent ? "TRAIN" : "HOLDOUT",
    bucket,
  };
}

function baselineAction(policy, ctx) {
  const fallback = ctx.availableActions?.[0] || "";
  const result = evaluatePolicy({
    policy,
    decisionType: ctx.decisionType,
    state: ctx.state,
    availableActions: ctx.availableActions,
    baselineAction: fallback,
  });
  return result.ok ? result.action : fallback;
}

function replayPolicy(world, policy, baselinePolicy) {
  return replayExact({
    world,
    chooseAction: (ctx) => {
      const base = baselineAction(baselinePolicy, ctx);
      if (policy.policy_id === baselinePolicy.policy_id) return base;

      const result = evaluatePolicy({
        policy,
        decisionType: ctx.decisionType,
        state: ctx.state,
        availableActions: ctx.availableActions,
        baselineAction: base,
      });

      if (result.ok) return result.action;
      if (result.diagnostic === POLICY_STATUS.NO_MATCHING_RULE) return base;
      return "__POLICY_INVALID_ACTION__";
    },
  });
}

function sanitizeReplayExample(world, report, lineage) {
  const firstDecision = world?.decisions?.[0] || {};
  return {
    lineage_ref: lineage.lineage_ref,
    split: lineage.split,
    state_bucket: stateBucket(firstDecision),
    replay_status: report.status,
    unknown_branch_count: report.unknown_branch_count,
    ineligible_trajectories: report.ineligible_trajectories,
    total_trajectories: report.total_trajectories,
  };
}

function sourceEntry(world, lineage) {
  return {
    lineage_ref: lineage.lineage_ref,
    split: lineage.split,
    split_bucket: lineage.bucket,
    world_manifest_hash: world.world_manifest_hash,
    root_snapshot_ref: "snapshot-" + sha256Canonical({
      snapshot: world.root_snapshot_id,
    }).slice(7, 23),
  };
}

export function loadSealedWorlds(repoRoot) {
  const dir = resolve(repoRoot, WORLDS_ROOT);
  if (!existsSync(dir)) {
    return { worlds: [], rejected: [], path: dir };
  }

  const worlds = [];
  const rejected = [];
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();

  for (const name of files) {
    const path = resolve(dir, name);
    let world;
    try {
      world = readJson(path);
    } catch {
      rejected.push({ file: name, reason: "MALFORMED_JSON" });
      continue;
    }
    const validation = validateWorld(world);
    if (!validation.valid) {
      rejected.push({ file: name, reason: "WORLD_INVALID" });
      continue;
    }
    worlds.push(world);
  }

  worlds.sort((a, b) => String(a.world_manifest_hash).localeCompare(String(b.world_manifest_hash)));
  return { worlds, rejected, path: dir };
}

export function loadCurrentPolicy(repoRoot) {
  const loaded = loadRuntimePolicy(repoRoot);
  if (!loaded.ok) {
    return {
      ok: false,
      reason: loaded.reason || "CURRENT_POLICY_NOT_FOUND",
      errors: loaded.errors || [],
      path: loaded.path || null,
    };
  }
  return {
    ok: true,
    policy: loaded.policy,
    path: loaded.path,
    source: loaded.source,
    diagnostic: loaded.diagnostic || null,
  };
}

export function buildPolicyDevelopmentDataset({
  worlds = [],
  currentPolicy,
  rejectedWorldCount = 0,
} = {}) {
  const policyValidation = validatePolicy(currentPolicy);
  if (!policyValidation.valid) {
    return { ok: false, reason: "CURRENT_POLICY_INVALID", errors: policyValidation.errors };
  }

  const validWorlds = [];
  for (const world of worlds) {
    const validation = validateWorld(world);
    if (!validation.valid) {
      return { ok: false, reason: "WORLD_INVALID", errors: validation.errors };
    }
    validWorlds.push(world);
  }
  validWorlds.sort((a, b) => String(a.world_manifest_hash).localeCompare(String(b.world_manifest_hash)));

  const stateBuckets = new Map();
  const bucketActionSupport = new Map();
  const support = new Map();
  const terminalOutcomes = {};
  const retryReasons = {};
  const firstPass = { accepted: 0, total: 0 };
  const costs = {
    model_calls: [],
    retries: [],
    tokens: [],
    latency_ms: [],
  };
  const sources = [];
  const replayExamples = [];
  const lineageAssignments = deriveLineageAssignments(validWorlds);

  for (const world of validWorlds) {
    const lineage = lineageAssignments.get(world.world_manifest_hash);
    if (!lineage) {
      return { ok: false, reason: "LINEAGE_ASSIGNMENT_MISSING" };
    }
    if (lineage.ambiguous || !lineage.lineage_root_snapshot_id) {
      return {
        ok: false,
        reason: "LINEAGE_ASSIGNMENT_AMBIGUOUS",
        world_manifest_hash: world.world_manifest_hash,
        terminal_roots: lineage.terminal_roots || [],
        cycle: lineage.cycle === true,
      };
    }
    const source = sourceEntry(world, lineage);
    sources.push(source);

    const baselineReplay = replayPolicy(world, currentPolicy, currentPolicy);
    const baselineReport = createReplayReport({
      world,
      replay: baselineReplay,
      candidatePolicyId: currentPolicy.policy_id,
    });

    firstPass.accepted += baselineReport.first_pass_count || 0;
    firstPass.total += baselineReport.total_trajectories || 0;
    for (const evaluated of baselineReport.evaluated_trajectories || []) {
      increment(terminalOutcomes, String(evaluated?.terminal_state || "UNKNOWN"));
      costs.retries.push(safeNumber(evaluated?.retries));
      const cm = evaluated?.cost_metrics || {};
      costs.model_calls.push(safeNumber(cm.model_calls));
      costs.tokens.push(
        safeNumber(cm.input_tokens)
        + safeNumber(cm.output_tokens)
        + safeNumber(cm.reasoning_tokens)
      );
      costs.latency_ms.push(safeNumber(cm.latency_ms ?? cm.latency));
    }

    const outcomeByDecision = new Map(
      (world.outcomes || []).map((o) => [o.decision_id, o])
    );

    for (const decision of world.decisions || []) {
      const bucket = stateBucket(decision);
      const existing = stateBuckets.get(bucket.bucket_id) || {
        ...bucket,
        count: 0,
        chosen_actions: {},
      };
      existing.count++;
      increment(existing.chosen_actions, String(decision.chosen_action || "UNKNOWN"));
      stateBuckets.set(bucket.bucket_id, existing);

      const bucketSupport = bucketActionSupport.get(bucket.bucket_id) || {};
      for (const legalAction of decision.available_actions || []) {
        const actionKey = String(legalAction);
        const actionStats = bucketSupport[actionKey] || {
          legal_occurrences: 0,
          observations: 0,
          accepted_observations: 0,
          terminal_outcomes: {},
        };
        actionStats.legal_occurrences++;
        bucketSupport[actionKey] = actionStats;
      }
      const chosenKey = String(decision.chosen_action || "");
      if (chosenKey) {
        const chosenStats = bucketSupport[chosenKey] || {
          legal_occurrences: 0,
          observations: 0,
          accepted_observations: 0,
          terminal_outcomes: {},
        };
        const chosenOutcome = outcomeByDecision.get(decision.decision_id);
        chosenStats.observations++;
        if (chosenOutcome?.terminal_state === "ACCEPTED") chosenStats.accepted_observations++;
        increment(chosenStats.terminal_outcomes, String(chosenOutcome?.terminal_state || "UNKNOWN"));
        bucketSupport[chosenKey] = chosenStats;
      }
      bucketActionSupport.set(bucket.bucket_id, bucketSupport);

      const retryReason = decision?.state?.retry_reason;
      if (retryReason) increment(retryReasons, String(retryReason));

      const exactKey = sha256Canonical({
        snapshot_id: decision.snapshot_id,
        decision_type: decision.decision_type,
        state: sanitizeState(decision.state || {}),
      });
      const branchSet = support.get(exactKey) || {
        decision_type: decision.decision_type,
        state_bucket_id: bucket.bucket_id,
        available_actions: new Set(),
        observations: new Map(),
      };
      for (const action of decision.available_actions || []) branchSet.available_actions.add(action);
      const action = String(decision.chosen_action || "");
      if (!branchSet.observations.has(action)) branchSet.observations.set(action, []);
      const outcome = outcomeByDecision.get(decision.decision_id);
      branchSet.observations.get(action).push({
        accepted: outcome?.terminal_state === "ACCEPTED",
        terminal_state: outcome?.terminal_state || "UNKNOWN",
      });
      support.set(exactKey, branchSet);
    }

    if (
      baselineReport.status === "NEEDS_EXPLORATION"
      || baselineReport.status === "INELIGIBLE"
    ) {
      replayExamples.push(sanitizeReplayExample(world, baselineReport, lineage));
    }
  }

  const branchCoverage = {
    total_legal_branches: 0,
    observed_branches: 0,
    unknown_branches: 0,
    ambiguous_branches: 0,
  };

  for (const item of support.values()) {
    for (const action of [...item.available_actions].sort()) {
      branchCoverage.total_legal_branches++;
      const observations = item.observations.get(action) || [];
      if (!observations.length) {
        branchCoverage.unknown_branches++;
        continue;
      }
      branchCoverage.observed_branches++;
      const acceptance = new Set(observations.map((o) => o.accepted));
      if (acceptance.size > 1) branchCoverage.ambiguous_branches++;
    }
  }

  const buckets = [...stateBuckets.values()]
    .map((item) => {
      const rawSupport = bucketActionSupport.get(item.bucket_id) || {};
      const actionSupport = {};
      for (const action of Object.keys(rawSupport).sort()) {
        const stats = rawSupport[action];
        actionSupport[action] = {
          legal_occurrences: stats.legal_occurrences,
          observations: stats.observations,
          accepted_observations: stats.accepted_observations,
          terminal_outcomes: sortedObject(stats.terminal_outcomes),
          unknown: stats.observations === 0,
        };
      }
      return {
        ...item,
        chosen_actions: sortedObject(item.chosen_actions),
        action_support: actionSupport,
      };
    })
    .sort((a, b) => a.bucket_id.localeCompare(b.bucket_id));

  const sourceManifest = sources.sort((a, b) =>
    a.world_manifest_hash.localeCompare(b.world_manifest_hash)
  );

  const splitCounts = {
    train_lineages: new Set(sourceManifest.filter((x) => x.split === "TRAIN").map((x) => x.lineage_ref)).size,
    holdout_lineages: new Set(sourceManifest.filter((x) => x.split === "HOLDOUT").map((x) => x.lineage_ref)).size,
  };

  const datasetWithoutId = {
    schema: POLICY_DATASET_SCHEMA,
    split_rule: {
      algorithm: "SHA256_ROOT_LINEAGE_MOD_100",
      train_percent: POLICY_LAB_LIMITS.train_percent,
      holdout_percent: POLICY_LAB_LIMITS.holdout_percent,
    },
    source_manifest: sourceManifest,
    source_world_count: validWorlds.length,
    rejected_world_count: rejectedWorldCount,
    split_counts: splitCounts,
    state_buckets: buckets,
    action_support: {
      ...branchCoverage,
      unknown_fraction: branchCoverage.total_legal_branches
        ? branchCoverage.unknown_branches / branchCoverage.total_legal_branches
        : 0,
      ambiguous_fraction: branchCoverage.observed_branches
        ? branchCoverage.ambiguous_branches / branchCoverage.observed_branches
        : 0,
    },
    terminal_outcomes: sortedObject(terminalOutcomes),
    first_pass: {
      ...firstPass,
      rate: firstPass.total ? firstPass.accepted / firstPass.total : 0,
    },
    retry_reasons: sortedObject(retryReasons),
    cost_quantiles: {
      model_calls: { p50: percentile(costs.model_calls, 0.5), p90: percentile(costs.model_calls, 0.9) },
      retries: { p50: percentile(costs.retries, 0.5), p90: percentile(costs.retries, 0.9) },
      tokens: { p50: percentile(costs.tokens, 0.5), p90: percentile(costs.tokens, 0.9) },
      latency_ms: { p50: percentile(costs.latency_ms, 0.5), p90: percentile(costs.latency_ms, 0.9) },
    },
    replay_counterexamples: replayExamples
      .sort((a, b) => a.lineage_ref.localeCompare(b.lineage_ref))
      .slice(0, POLICY_LAB_LIMITS.max_structured_examples),
    current_policy: structuredClone(currentPolicy),
  };

  const datasetId = "dataset-" + sha256Canonical(datasetWithoutId).slice(7);
  return {
    ok: true,
    dataset: {
      dataset_id: datasetId,
      ...datasetWithoutId,
    },
  };
}

export function persistPolicyDevelopmentDataset(repoRoot, dataset) {
  if (!dataset || dataset.schema !== POLICY_DATASET_SCHEMA || !dataset.dataset_id) {
    return { written: false, reason: "INVALID_DATASET" };
  }
  const integrity = validateDatasetIntegrity(dataset);
  if (!integrity.valid) {
    return { written: false, reason: integrity.reason, errors: integrity.errors || [] };
  }
  const path = resolve(repoRoot, LAB_ROOT, "datasets", dataset.dataset_id + ".json");
  atomicJson(path, dataset);
  return { written: true, path };
}

export function buildAndPersistPolicyDataset(repoRoot) {
  const loadedWorlds = loadSealedWorlds(repoRoot);
  const current = loadCurrentPolicy(repoRoot);
  if (!current.ok) return current;

  const built = buildPolicyDevelopmentDataset({
    worlds: loadedWorlds.worlds,
    currentPolicy: current.policy,
    rejectedWorldCount: loadedWorlds.rejected.length,
  });
  if (!built.ok) return built;

  const persisted = persistPolicyDevelopmentDataset(repoRoot, built.dataset);
  if (!persisted.written) return persisted;
  return {
    ok: true,
    dataset: built.dataset,
    path: persisted.path,
    rejected_worlds: loadedWorlds.rejected,
  };
}

export function openPolicyLabCycle({ repoRoot, dataset } = {}) {
  if (!repoRoot || !dataset?.dataset_id || dataset.schema !== POLICY_DATASET_SCHEMA) {
    return { opened: false, reason: "INVALID_CYCLE_INPUT" };
  }
  const datasetIntegrity = validateDatasetIntegrity(dataset);
  if (!datasetIntegrity.valid) {
    return { opened: false, reason: datasetIntegrity.reason, errors: datasetIntegrity.errors || [] };
  }
  const persistedDatasetPath = resolve(
    repoRoot,
    LAB_ROOT,
    "datasets",
    dataset.dataset_id + ".json",
  );
  if (!existsSync(persistedDatasetPath)) {
    return { opened: false, reason: "DATASET_NOT_BUILT_LOCALLY" };
  }
  let persistedDataset;
  try {
    persistedDataset = readJson(persistedDatasetPath);
  } catch {
    return { opened: false, reason: "PERSISTED_DATASET_INVALID" };
  }
  const persistedIntegrity = validateDatasetIntegrity(persistedDataset);
  if (
    !persistedIntegrity.valid
    || persistedDataset.dataset_id !== dataset.dataset_id
    || sha256Canonical(persistedDataset) !== sha256Canonical(dataset)
  ) {
    return { opened: false, reason: "PERSISTED_DATASET_MISMATCH" };
  }
  const baseline = dataset.current_policy;
  const validation = validatePolicy(baseline);
  if (!validation.valid) {
    return { opened: false, reason: "BASELINE_POLICY_INVALID", errors: validation.errors };
  }

  const cycleId = "cycle-" + sha256Canonical({
    dataset_id: dataset.dataset_id,
    baseline_policy_id: baseline.policy_id,
  }).slice(7);
  const path = resolve(repoRoot, LAB_ROOT, "cycles", cycleId + ".json");

  if (existsSync(path)) {
    const existing = readCycle(repoRoot, path);
    if (existing.ok && existing.cycle?.cycle_id === cycleId) {
      return { opened: true, existing: true, cycle: existing.cycle, path };
    }
    return { opened: false, reason: existing.reason || "CYCLE_ARTIFACT_CONFLICT" };
  }

  const cycle = {
    schema: POLICY_CYCLE_SCHEMA,
    cycle_id: cycleId,
    dataset_id: dataset.dataset_id,
    baseline_policy_id: baseline.policy_id,
    limits: {
      max_designer_calls: POLICY_LAB_LIMITS.max_designer_calls,
      max_candidates_per_call: POLICY_LAB_LIMITS.max_candidates_per_call,
    },
    designer_calls: [],
    candidates: [
      {
        policy_id: baseline.policy_id,
        source: "BASELINE",
      },
    ],
    status: "OPEN",
    activation_allowed: false,
  };
  const stored = writeCycle(path, cycle);
  return { opened: true, existing: false, cycle: stored, path };
}

function materializeCandidate(raw, baselinePolicyId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, errors: ["Candidate must be a JSON object"] };
  }
  const candidate = structuredClone(raw);
  delete candidate.policy_id;
  delete candidate.created_at;
  candidate.base_policy = baselinePolicyId;
  candidate.policy_id = computePolicyId(candidate);
  const validation = validatePolicy(candidate);
  if (!validation.valid) {
    return { valid: false, errors: validation.errors };
  }
  return { valid: true, policy: candidate };
}

export function submitDesignerCandidates({
  repoRoot,
  cyclePath,
  candidates,
  packetId,
} = {}) {
  if (!repoRoot || !cyclePath) {
    return { accepted: false, reason: "INVALID_DESIGNER_SUBMISSION" };
  }

  const loadedCycle = readCycle(repoRoot, cyclePath);
  if (!loadedCycle.ok) return { accepted: false, reason: loadedCycle.reason };
  const cycle = loadedCycle.cycle;
  const pendingCall = cycle.designer_calls.at(-1);

  if (
    cycle.status !== "DESIGNER_PENDING"
    || !pendingCall
    || pendingCall.status !== "PACKET_ISSUED"
  ) {
    if (cycle.designer_calls.length >= POLICY_LAB_LIMITS.max_designer_calls) {
      return { accepted: false, reason: "DESIGNER_CALL_BUDGET_EXHAUSTED" };
    }
    return { accepted: false, reason: "DESIGNER_PACKET_REQUIRED" };
  }

  const callIndex = pendingCall.call_index;

  function rejectCall(reason) {
    pendingCall.status = "REJECTED";
    pendingCall.submitted_count = Array.isArray(candidates) ? candidates.length : null;
    pendingCall.accepted_policy_ids = [];
    pendingCall.rejected_count = Array.isArray(candidates) ? candidates.length : null;
    pendingCall.rejection_reason = reason;
    cycle.status = "OPEN";
    const stored = writeCycle(cyclePath, cycle);
    return {
      accepted: false,
      reason,
      call_index: callIndex,
      cycle: stored,
    };
  }

  if (typeof packetId !== "string" || packetId !== pendingCall.packet_id) {
    return rejectCall("DESIGNER_PACKET_ID_MISMATCH");
  }
  if (!Array.isArray(candidates)) {
    return rejectCall("INVALID_DESIGNER_SUBMISSION");
  }
  if (candidates.length > POLICY_LAB_LIMITS.max_candidates_per_call) {
    return rejectCall("TOO_MANY_CANDIDATES_IN_CALL");
  }

  const accepted = [];
  const rejected = [];

  for (let i = 0; i < candidates.length; i++) {
    const materialized = materializeCandidate(candidates[i], cycle.baseline_policy_id);
    if (!materialized.valid) {
      rejected.push({ candidate_index: i, errors: materialized.errors });
      continue;
    }
    const policy = materialized.policy;
    const candidatePath = resolve(repoRoot, LAB_ROOT, "candidates", policy.policy_id + ".json");
    atomicJson(candidatePath, policy);
    if (!cycle.candidates.some((entry) => entry.policy_id === policy.policy_id)) {
      cycle.candidates.push({
        policy_id: policy.policy_id,
        source: callIndex === 1 ? "DESIGNER_CALL_1" : "DESIGNER_CALL_2",
      });
    }
    accepted.push({ policy_id: policy.policy_id, path: candidatePath });
  }

  pendingCall.status = "SUBMITTED";
  pendingCall.submitted_count = candidates.length;
  pendingCall.accepted_policy_ids = accepted.map((x) => x.policy_id).sort();
  pendingCall.rejected_count = rejected.length;
  cycle.status = "OPEN";
  const storedCycle = writeCycle(cyclePath, cycle);

  return {
    accepted: true,
    call_index: callIndex,
    cycle: storedCycle,
    accepted_candidates: accepted,
    rejected_candidates: rejected,
  };
}

function loadDatasetForCycle(repoRoot, cycle) {
  const path = resolve(repoRoot, LAB_ROOT, "datasets", cycle.dataset_id + ".json");
  if (!existsSync(path)) return { ok: false, reason: "CYCLE_DATASET_MISSING" };
  const dataset = readJson(path);
  if (dataset?.dataset_id !== cycle.dataset_id) {
    return { ok: false, reason: "CYCLE_DATASET_INVALID" };
  }
  const integrity = validateDatasetIntegrity(dataset);
  if (!integrity.valid) return { ok: false, reason: "CYCLE_DATASET_TAMPERED", errors: integrity.errors || [] };
  return { ok: true, dataset, path };
}

function loadWorldsForDataset(repoRoot, dataset) {
  const loaded = loadSealedWorlds(repoRoot);
  const byManifest = new Map(loaded.worlds.map((w) => [w.world_manifest_hash, w]));
  const worlds = [];
  for (const source of dataset.source_manifest || []) {
    const world = byManifest.get(source.world_manifest_hash);
    if (!world) {
      return {
        ok: false,
        reason: "DATASET_WORLD_MISSING_OR_CHANGED",
        world_manifest_hash: source.world_manifest_hash,
      };
    }
    worlds.push({
      world,
      split: source.split,
      lineage_ref: source.lineage_ref,
    });
  }
  return { ok: true, worlds };
}

function loadCandidatePolicy(repoRoot, dataset, entry) {
  if (entry.source === "BASELINE") {
    return { ok: true, policy: dataset.current_policy };
  }
  const path = resolve(repoRoot, LAB_ROOT, "candidates", entry.policy_id + ".json");
  if (!existsSync(path)) return { ok: false, reason: "CANDIDATE_POLICY_MISSING", policy_id: entry.policy_id };
  const policy = readJson(path);
  const validation = validatePolicy(policy);
  if (!validation.valid || policy.policy_id !== entry.policy_id) {
    return { ok: false, reason: "CANDIDATE_POLICY_INVALID", policy_id: entry.policy_id, errors: validation.errors };
  }
  return { ok: true, policy };
}

function aggregateReports(items) {
  const aggregate = {
    world_count: items.length,
    total_trajectories: 0,
    ineligible_trajectories: 0,
    unknown_branch_count: 0,
    accepted_count: 0,
    evidence_complete_count: 0,
    first_pass_count: 0,
    total_retries: 0,
    total_model_calls: 0,
    total_tokens: 0,
    total_latency_ms: 0,
  };

  for (const { report } of items) {
    aggregate.total_trajectories += report.total_trajectories || 0;
    aggregate.ineligible_trajectories += report.ineligible_trajectories || 0;
    aggregate.unknown_branch_count += report.unknown_branch_count || 0;
    aggregate.accepted_count += report.accepted_count || 0;
    aggregate.first_pass_count += report.first_pass_count || 0;
    aggregate.total_retries += report.total_retries || 0;
    const cost = report.aggregate_cost_metrics || {};
    aggregate.total_model_calls += safeNumber(cost.model_calls);
    aggregate.total_tokens += safeNumber(cost.input_tokens) + safeNumber(cost.output_tokens) + safeNumber(cost.reasoning_tokens);
    aggregate.total_latency_ms += safeNumber(cost.latency_ms);

    for (const evaluated of report.evaluated_trajectories || []) {
      if (evaluated?.evidence_completeness?.complete) aggregate.evidence_complete_count++;
    }
  }

  const denom = aggregate.total_trajectories || 1;
  const acceptedDenom = aggregate.accepted_count || null;
  return {
    ...aggregate,
    acceptance_rate: aggregate.accepted_count / denom,
    evidence_complete_rate: aggregate.evidence_complete_count / denom,
    first_pass_rate: aggregate.first_pass_count / denom,
    retries_per_accepted: acceptedDenom ? aggregate.total_retries / acceptedDenom : null,
    model_calls_per_accepted: acceptedDenom ? aggregate.total_model_calls / acceptedDenom : null,
    tokens_per_accepted: acceptedDenom ? aggregate.total_tokens / acceptedDenom : null,
    latency_ms_per_accepted: acceptedDenom ? aggregate.total_latency_ms / acceptedDenom : null,
    complete_support: aggregate.ineligible_trajectories === 0 && aggregate.unknown_branch_count === 0,
  };
}

function compareMetric(candidate, baseline, higherBetter) {
  if (candidate === null || baseline === null) return 0;
  if (candidate === baseline) return 0;
  if (higherBetter) return candidate > baseline ? 1 : -1;
  return candidate < baseline ? 1 : -1;
}

export function compareAggregateReports(candidate, baseline) {
  if (candidate.ineligible_trajectories > 0) {
    return { relation: "INELIGIBLE", dimension: "SAFETY_FIDELITY" };
  }
  if (candidate.unknown_branch_count > 0) {
    return { relation: "INSUFFICIENT_SUPPORT", dimension: "SUPPORT" };
  }

  const dimensions = [
    ["ACCEPTANCE", "acceptance_rate", true],
    ["EVIDENCE_COMPLETENESS", "evidence_complete_rate", true],
    ["FIRST_PASS_ACCEPTANCE", "first_pass_rate", true],
    ["RETRY_COST", "retries_per_accepted", false],
    ["MODEL_CALLS", "model_calls_per_accepted", false],
    ["TOKENS", "tokens_per_accepted", false],
    ["LATENCY", "latency_ms_per_accepted", false],
  ];

  for (const [dimension, key, higherBetter] of dimensions) {
    const cmp = compareMetric(candidate[key], baseline[key], higherBetter);
    if (cmp > 0) return { relation: "SUPERIOR", dimension };
    if (cmp < 0) return { relation: "INFERIOR", dimension };
  }
  return { relation: "EQUIVALENT", dimension: "NONE" };
}

function materialImprovement(candidate, baseline, comparison) {
  if (comparison.relation !== "SUPERIOR") return { material: false, reasons: [] };

  if (["ACCEPTANCE", "EVIDENCE_COMPLETENESS"].includes(comparison.dimension)) {
    return { material: true, reasons: [comparison.dimension] };
  }

  const reasons = [];
  const callsBase = baseline.model_calls_per_accepted;
  const callsCandidate = candidate.model_calls_per_accepted;
  if (
    callsBase !== null && callsBase > 0 && callsCandidate !== null
    && (callsBase - callsCandidate) / callsBase >= 0.05
  ) {
    reasons.push("MODEL_CALLS_REDUCTION_GTE_5_PERCENT");
  }

  const retryBase = baseline.retries_per_accepted;
  const retryCandidate = candidate.retries_per_accepted;
  if (
    retryBase !== null && retryBase > 0 && retryCandidate !== null
    && (retryBase - retryCandidate) / retryBase >= 0.10
  ) {
    reasons.push("RETRY_REDUCTION_GTE_10_PERCENT");
  }

  if (candidate.first_pass_rate - baseline.first_pass_rate >= 0.02) {
    reasons.push("FIRST_PASS_INCREASE_GTE_2PP");
  }

  return { material: reasons.length > 0, reasons };
}

function feedbackExamples(items) {
  return items
    .filter(({ report }) =>
      report.status === "NEEDS_EXPLORATION"
      || report.status === "INELIGIBLE"
    )
    .map(({ world, split, lineage_ref, report }) =>
      sanitizeReplayExample(world, report, { split, lineage_ref }))
    .sort((a, b) => a.lineage_ref.localeCompare(b.lineage_ref))
    .slice(0, POLICY_LAB_LIMITS.max_structured_examples);
}

function loadDesignerReplayFeedback(repoRoot, cycle) {
  if (!cycle.last_evaluation_id) return null;
  const evaluationPath = resolve(
    repoRoot,
    LAB_ROOT,
    "evaluations",
    cycle.last_evaluation_id + ".json",
  );
  if (!existsSync(evaluationPath)) return null;

  let evaluation;
  try {
    evaluation = readJson(evaluationPath);
  } catch {
    return null;
  }
  if (
    evaluation?.schema !== POLICY_EVALUATION_SCHEMA
    || evaluation?.evaluation_id !== cycle.last_evaluation_id
  ) {
    return null;
  }

  return {
    evaluation_id: evaluation.evaluation_id,
    candidates: (evaluation.candidates || []).map((item) => ({
      policy_id: item.policy_id,
      source: item.source,
      status: item.status,
      train_comparison: item.train_comparison || null,
      holdout_comparison: item.holdout_comparison || null,
      materiality: item.materiality || null,
      feedback_examples: (item.feedback_examples || [])
        .slice(0, POLICY_LAB_LIMITS.max_structured_examples),
    })),
  };
}

function createDesignerPacket({ cycle, dataset, callIndex, replayFeedback }) {
  const body = {
    schema: "orchestra.policy-designer-packet.v1",
    cycle_id: cycle.cycle_id,
    dataset_id: dataset.dataset_id,
    designer_call_index: callIndex,
    limits: {
      max_candidates_this_call: POLICY_LAB_LIMITS.max_candidates_per_call,
      max_total_designer_calls: POLICY_LAB_LIMITS.max_designer_calls,
    },
    dataset: {
      split_counts: dataset.split_counts,
      state_buckets: dataset.state_buckets,
      action_support: dataset.action_support,
      terminal_outcomes: dataset.terminal_outcomes,
      first_pass: dataset.first_pass,
      retry_reasons: dataset.retry_reasons,
      cost_quantiles: dataset.cost_quantiles,
      replay_counterexamples: dataset.replay_counterexamples,
      current_policy: dataset.current_policy,
    },
    replay_feedback: replayFeedback,
    output_contract: {
      format: "JSON_ONLY",
      shape: {
        packet_id: "echo packet_id exactly",
        candidates: "array<orchestra.exploration-policy.v1>",
      },
      max_candidates: POLICY_LAB_LIMITS.max_candidates_per_call,
      forbidden: [
        "raw history",
        "user prompts",
        "terminal logs",
        "web/file content",
        "policy activation",
        "governance edits",
      ],
    },
  };
  return {
    packet_id: "packet-" + sha256Canonical(body).slice(7),
    ...body,
  };
}

export function buildPolicyDesignerPacket({ repoRoot, cyclePath } = {}) {
  if (!repoRoot || !cyclePath) return { ok: false, reason: "INVALID_DESIGNER_PACKET_INPUT" };
  const loadedCycle = readCycle(repoRoot, cyclePath);
  if (!loadedCycle.ok) return { ok: false, reason: loadedCycle.reason };
  const cycle = loadedCycle.cycle;

  const loadedDataset = loadDatasetForCycle(repoRoot, cycle);
  if (!loadedDataset.ok) return loadedDataset;
  const dataset = loadedDataset.dataset;
  const replayFeedback = loadDesignerReplayFeedback(repoRoot, cycle);

  const pendingCall = cycle.designer_calls.at(-1);
  if (cycle.status === "DESIGNER_PENDING" && pendingCall?.status === "PACKET_ISSUED") {
    const packet = createDesignerPacket({
      cycle,
      dataset,
      callIndex: pendingCall.call_index,
      replayFeedback,
    });
    if (packet.packet_id !== pendingCall.packet_id) {
      return { ok: false, reason: "PENDING_DESIGNER_PACKET_CONTEXT_CHANGED" };
    }
    return { ok: true, pending: true, packet, cycle };
  }

  if (!["OPEN", "EVALUATED"].includes(cycle.status)) {
    return { ok: false, reason: "CYCLE_NOT_READY_FOR_DESIGNER" };
  }
  if (cycle.designer_calls.length >= POLICY_LAB_LIMITS.max_designer_calls) {
    return { ok: false, reason: "DESIGNER_CALL_BUDGET_EXHAUSTED" };
  }

  const callIndex = cycle.designer_calls.length + 1;
  const packet = createDesignerPacket({
    cycle,
    dataset,
    callIndex,
    replayFeedback,
  });

  cycle.designer_calls.push({
    call_index: callIndex,
    packet_id: packet.packet_id,
    status: "PACKET_ISSUED",
  });
  cycle.status = "DESIGNER_PENDING";
  const storedCycle = writeCycle(cyclePath, cycle);

  return {
    ok: true,
    pending: false,
    packet,
    cycle: storedCycle,
  };
}

export function evaluatePolicyLabCycle({ repoRoot, cyclePath } = {}) {
  if (!repoRoot || !cyclePath) return { evaluated: false, reason: "INVALID_EVALUATION_INPUT" };
  const loadedCycle = readCycle(repoRoot, cyclePath);
  if (!loadedCycle.ok) return { evaluated: false, reason: loadedCycle.reason };
  const cycle = loadedCycle.cycle;
  if (cycle.status === "DESIGNER_PENDING") {
    return { evaluated: false, reason: "DESIGNER_CALL_PENDING" };
  }

  const loadedDataset = loadDatasetForCycle(repoRoot, cycle);
  if (!loadedDataset.ok) return { evaluated: false, ...loadedDataset };
  const dataset = loadedDataset.dataset;

  const loadedWorlds = loadWorldsForDataset(repoRoot, dataset);
  if (!loadedWorlds.ok) return { evaluated: false, ...loadedWorlds };

  const baselinePolicy = dataset.current_policy;
  const policyResults = [];
  let baselineBySplit = null;

  for (const entry of cycle.candidates) {
    const loadedPolicy = loadCandidatePolicy(repoRoot, dataset, entry);
    if (!loadedPolicy.ok) return { evaluated: false, ...loadedPolicy };
    const policy = loadedPolicy.policy;

    const reports = [];
    for (const source of loadedWorlds.worlds) {
      const replay = replayPolicy(source.world, policy, baselinePolicy);
      const report = createReplayReport({
        world: source.world,
        replay,
        candidatePolicyId: policy.policy_id,
      });
      reports.push({
        world: source.world,
        split: source.split,
        lineage_ref: source.lineage_ref,
        report,
      });
    }

    const trainItems = reports.filter((item) => item.split === "TRAIN");
    const holdoutItems = reports.filter((item) => item.split === "HOLDOUT");
    const train = aggregateReports(trainItems);
    const holdout = aggregateReports(holdoutItems);

    if (entry.source === "BASELINE") {
      baselineBySplit = { train, holdout };
      policyResults.push({
        policy_id: policy.policy_id,
        source: "BASELINE",
        status: "BASELINE",
        train,
        holdout,
        activation_allowed: false,
        feedback_examples: feedbackExamples(reports),
      });
      continue;
    }

    const trainComparison = compareAggregateReports(train, baselineBySplit.train);
    const holdoutComparison = compareAggregateReports(holdout, baselineBySplit.holdout);
    const materiality = materialImprovement(holdout, baselineBySplit.holdout, holdoutComparison);

    let status;
    if (train.ineligible_trajectories > 0 || holdout.ineligible_trajectories > 0) {
      status = "INELIGIBLE";
    } else if (train.unknown_branch_count > 0 || holdout.unknown_branch_count > 0) {
      status = "NEEDS_EXPLORATION";
    } else if (
      trainComparison.relation === "INFERIOR"
      || holdoutComparison.relation === "INFERIOR"
    ) {
      status = "REGRESSION";
    } else if (holdoutComparison.relation === "SUPERIOR" && materiality.material) {
      status = "RECOMMENDATION_CANDIDATE";
    } else if (holdoutComparison.relation === "SUPERIOR") {
      status = "IMPROVEMENT_BELOW_MATERIALITY_THRESHOLD";
    } else {
      status = "EQUIVALENT";
    }

    policyResults.push({
      policy_id: policy.policy_id,
      source: entry.source,
      status,
      train,
      holdout,
      train_comparison: trainComparison,
      holdout_comparison: holdoutComparison,
      materiality,
      activation_allowed: false,
      feedback_examples: feedbackExamples(reports),
    });
  }

  const sampleGate = {
    train_lineages: dataset.split_counts.train_lineages,
    holdout_lineages: dataset.split_counts.holdout_lineages,
    min_train_lineages: POLICY_LAB_LIMITS.promotion_min_train_lineages,
    min_holdout_lineages: POLICY_LAB_LIMITS.promotion_min_holdout_lineages,
    sufficient:
      dataset.split_counts.train_lineages >= POLICY_LAB_LIMITS.promotion_min_train_lineages
      && dataset.split_counts.holdout_lineages >= POLICY_LAB_LIMITS.promotion_min_holdout_lineages,
  };

  const reportWithoutId = {
    schema: POLICY_EVALUATION_SCHEMA,
    cycle_id: cycle.cycle_id,
    dataset_id: dataset.dataset_id,
    baseline_policy_id: cycle.baseline_policy_id,
    sample_gate: sampleGate,
    candidates: policyResults,
    recommended_candidate_ids: policyResults
      .filter((item) => item.status === "RECOMMENDATION_CANDIDATE")
      .map((item) => item.policy_id)
      .sort(),
    activation_allowed: false,
    next_milestone_required_for_activation: "SHADOW_MODE",
  };

  const evaluationId = "evaluation-" + sha256Canonical(reportWithoutId).slice(7);
  const evaluation = { evaluation_id: evaluationId, ...reportWithoutId };
  const path = resolve(repoRoot, LAB_ROOT, "evaluations", evaluationId + ".json");
  atomicJson(path, evaluation);

  cycle.last_evaluation_id = evaluationId;
  cycle.status = "EVALUATED";
  cycle.activation_allowed = false;
  const storedCycle = writeCycle(cyclePath, cycle);

  return { evaluated: true, evaluation, path, cycle: storedCycle };
}
