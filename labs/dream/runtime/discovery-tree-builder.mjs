import { DREAM_SCHEMAS } from "./records.mjs";
import { validateWorld } from "./world-sealer.mjs";

/**
 * Branch status classifications for causal discovery trees.
 */
export const BRANCH_STATUS = Object.freeze({
  OBSERVED_ONCE: "OBSERVED_ONCE",
  OBSERVED_MULTIPLE_CONSISTENT: "OBSERVED_MULTIPLE_CONSISTENT",
  AMBIGUOUS_OBSERVED: "AMBIGUOUS_OBSERVED",
  UNKNOWN_BRANCH: "UNKNOWN_BRANCH",
});

/**
 * Evaluates whether an observation reflects terminal acceptance.
 *
 * @param {Record<string, unknown>} obs
 * @returns {boolean}
 */
function isAcceptedObservation(obs) {
  if (obs.terminal_state === "ACCEPTED") return true;
  if (obs.terminal_state && obs.terminal_state !== "ACCEPTED") return false;
  if (obs.result === "SUCCESS" || obs.result === "ACCEPTED") return true;
  if (typeof obs.result === "object" && obs.result !== null) {
    if (obs.result.status === "ACCEPTED" || obs.result.status === "SUCCESS") return true;
  }
  return false;
}

/**
 * Derives a causal discovery tree from a sealed factual world record.
 * Preserves causal lineage, groups by exact snapshot_id + action,
 * handles multi-observation branches with ambiguity detection,
 * classifies legal unobserved branches as UNKNOWN_BRANCH,
 * and retains content-addressed snapshot indexing without lineage mutation.
 *
 * @param {Record<string, unknown>} world
 * @returns {{
 *   world_id: string,
 *   root_snapshot_id: string,
 *   nodes: Record<string, {
 *     snapshot_id: string,
 *     actions: Record<string, {
 *       action: string,
 *       status: string,
 *       observations: Array<{
 *         observation_id: string,
 *         decision_id: string,
 *         result: unknown,
 *         resulting_snapshot_id: string | null,
 *         terminal_state: string | null,
 *         cost_metrics: Record<string, unknown>,
 *         evidence_summary: Record<string, unknown>,
 *       }>
 *     }>
 *   }>,
 *   metadata: {
 *     total_nodes: number,
 *     total_observations: number,
 *     unknown_branches: number,
 *     ambiguous_branches: number,
 *   }
 * }}
 */
export function buildDiscoveryTree(world) {
  if (!world || typeof world !== "object" || Array.isArray(world)) {
    throw new Error("INVALID_SEALED_WORLD: world must be an object");
  }

  const validation = validateWorld(world);
  if (!validation.valid) {
    throw new Error(`INVALID_SEALED_WORLD: ${validation.errors.join(", ")}`);
  }

  // 1. Extract decisions and outcomes from the world record
  const events = Array.isArray(world.events) ? world.events : [];
  const decisions = Array.isArray(world.decisions) && world.decisions.length > 0
    ? [...world.decisions]
    : events.filter((ev) => ev?.type === "DECISION" || ev?.schema === DREAM_SCHEMAS.DECISION);
  const outcomes = Array.isArray(world.outcomes) && world.outcomes.length > 0
    ? [...world.outcomes]
    : events.filter((ev) => ev?.type === "DECISION_OUTCOME" || ev?.schema === DREAM_SCHEMAS.OUTCOME);

  // 2. Index outcomes by decision_id
  const outcomesByDecisionId = new Map();
  for (const out of outcomes) {
    if (out && out.decision_id) {
      outcomesByDecisionId.set(out.decision_id, out);
    }
  }

  // 3. Group decisions by snapshot_id (preserving causal ordering)
  const decisionsBySnapshot = new Map();
  for (const dec of decisions) {
    if (!dec || !dec.snapshot_id) continue;
    if (!decisionsBySnapshot.has(dec.snapshot_id)) {
      decisionsBySnapshot.set(dec.snapshot_id, []);
    }
    decisionsBySnapshot.get(dec.snapshot_id).push(dec);
  }

  // Ensure root snapshot is tracked even if no decisions taken at it
  if (world.root_snapshot_id && !decisionsBySnapshot.has(world.root_snapshot_id)) {
    decisionsBySnapshot.set(world.root_snapshot_id, []);
  }

  // Ensure terminal resulting snapshots without further decisions are indexed as nodes
  for (const out of outcomes) {
    const resSnap = out?.resulting_snapshot_id;
    if (resSnap && typeof resSnap === "string" && !decisionsBySnapshot.has(resSnap)) {
      decisionsBySnapshot.set(resSnap, []);
    }
  }

  // 4. Build nodes indexed by snapshot_id
  const nodes = {};

  for (const [snapshotId, decsAtSnapshot] of decisionsBySnapshot.entries()) {
    const availableActionsSet = new Set();
    for (const dec of decsAtSnapshot) {
      if (Array.isArray(dec.available_actions)) {
        for (const act of dec.available_actions) {
          availableActionsSet.add(act);
        }
      }
      if (dec.chosen_action) {
        availableActionsSet.add(dec.chosen_action);
      }
    }

    const actions = {};

    for (const action of availableActionsSet) {
      const observations = [];

      for (const dec of decsAtSnapshot) {
        if (dec.chosen_action === action) {
          const matchingOutcome = outcomesByDecisionId.get(dec.decision_id);
          if (matchingOutcome) {
            observations.push({
              observation_id: matchingOutcome.observation_id,
              decision_id: dec.decision_id,
              result: matchingOutcome.result,
              resulting_snapshot_id: matchingOutcome.resulting_snapshot_id ?? null,
              terminal_state: matchingOutcome.terminal_state ?? null,
              cost_metrics: matchingOutcome.cost_metrics ?? {},
              evidence_summary: matchingOutcome.evidence_summary ?? {},
            });
          }
        }
      }

      let status;
      if (observations.length === 0) {
        status = BRANCH_STATUS.UNKNOWN_BRANCH;
      } else if (observations.length === 1) {
        status = BRANCH_STATUS.OBSERVED_ONCE;
      } else {
        const allAccepted = observations.every(isAcceptedObservation);
        const allNotAccepted = observations.every((obs) => !isAcceptedObservation(obs));
        status = (allAccepted || allNotAccepted)
          ? BRANCH_STATUS.OBSERVED_MULTIPLE_CONSISTENT
          : BRANCH_STATUS.AMBIGUOUS_OBSERVED;
      }

      actions[action] = {
        action,
        status,
        observations,
      };
    }

    nodes[snapshotId] = {
      snapshot_id: snapshotId,
      actions,
    };
  }

  // 5. Calculate metadata statistics
  let totalObservations = 0;
  let unknownBranches = 0;
  let ambiguousBranches = 0;

  for (const node of Object.values(nodes)) {
    for (const actionObj of Object.values(node.actions)) {
      totalObservations += actionObj.observations.length;
      if (actionObj.status === BRANCH_STATUS.UNKNOWN_BRANCH) {
        unknownBranches++;
      } else if (actionObj.status === BRANCH_STATUS.AMBIGUOUS_OBSERVED) {
        ambiguousBranches++;
      }
    }
  }

  const metadata = {
    total_nodes: Object.keys(nodes).length,
    total_observations: totalObservations,
    unknown_branches: unknownBranches,
    ambiguous_branches: ambiguousBranches,
  };

  const tree = {
    world_id: world.world_id,
    root_snapshot_id: world.root_snapshot_id,
    nodes,
    metadata,
  };

  // Provide snapshots alias for indexed content-addressed snapshot lookup
  Object.defineProperty(tree, "snapshots", {
    get() {
      return this.nodes;
    },
    enumerable: false,
    configurable: true,
  });

  return tree;
}
