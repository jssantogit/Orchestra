import { canonicalize, sha256Canonical } from "./canonical.mjs";
import { validateWorld } from "./world-sealer.mjs";
import { buildDiscoveryTree, BRANCH_STATUS } from "./discovery-tree-builder.mjs";

/**
 * Replay status classifications following Orchestra Dream Layer specification.
 */
export const REPLAY_STATUS = Object.freeze({
  REPLAY_EXACT_SINGLE: "REPLAY_EXACT_SINGLE",
  REPLAY_EXACT_MULTI_OBSERVATION: "REPLAY_EXACT_MULTI_OBSERVATION",
  EXACT_REPLAY_COMPLETE: "EXACT_REPLAY_COMPLETE",
  EXACT_REPLAY_PARTIAL: "EXACT_REPLAY_PARTIAL",
  UNKNOWN_BRANCH: "UNKNOWN_BRANCH",
  POLICY_INVALID_ACTION: "POLICY_INVALID_ACTION",
  REPLAY_COMPLEXITY_LIMIT: "REPLAY_COMPLEXITY_LIMIT",
  WORLD_INVALID: "WORLD_INVALID",
});

/**
 * Merges cost metrics accumulating numeric fields deterministically.
 *
 * @param {Record<string, unknown>} acc
 * @param {Record<string, unknown>} next
 * @returns {Record<string, unknown>}
 */
function mergeCostMetrics(acc, next) {
  if (!next || typeof next !== "object") return acc ? { ...acc } : {};
  const merged = { ...(acc || {}) };
  for (const [k, v] of Object.entries(next)) {
    if (typeof v === "number") {
      merged[k] = (typeof merged[k] === "number" ? merged[k] : 0) + v;
    } else if (!(k in merged)) {
      merged[k] = v;
    }
  }
  return merged;
}

/**
 * Replays a policy callback over a sealed factual world record.
 * Operates purely locally with zero model calls, prefix-only visibility,
 * exact-match branch checking (unknown branches halt immediately),
 * multi-observation branching, and complexity limits.
 *
 * @param {{
 *   world: Record<string, unknown>,
 *   chooseAction: (ctx: {
 *     decisionType: string,
 *     state: Record<string, unknown>,
 *     availableActions: string[],
 *     snapshotId: string,
 *     prefix: Array<Record<string, unknown>>
 *   }) => string,
 *   maxTrajectories?: number
 * }} options
 * @returns {{
 *   status: string,
 *   trajectories: Array<{
 *     status: string,
 *     steps: Array<{
 *       snapshot_id: string,
 *       decision_type: string,
 *       chosen_action: string,
 *       observation_id: string,
 *       result: unknown,
 *       resulting_snapshot_id: string | null,
 *       terminal_state: string | null
 *     }>,
 *     terminal_state: string | null,
 *     cost_metrics: Record<string, unknown>,
 *     branch_type?: string
 *   }>,
 *   metadata: {
 *     total_trajectories: number,
 *     complete_trajectories: number,
 *     unknown_trajectories: number,
 *     invalid_policy_trajectories: number
 *   },
 *   errors?: string[]
 * }}
 */
export function replayExact({ world, chooseAction, maxTrajectories = 10000 }) {
  if (!world || typeof world !== "object" || Array.isArray(world)) {
    return {
      status: REPLAY_STATUS.WORLD_INVALID,
      errors: ["World record must be a non-null object"],
      trajectories: [],
      metadata: {
        total_trajectories: 0,
        complete_trajectories: 0,
        unknown_trajectories: 0,
        invalid_policy_trajectories: 0,
      },
    };
  }

  const validation = validateWorld(world);
  if (!validation.valid) {
    return {
      status: REPLAY_STATUS.WORLD_INVALID,
      errors: validation.errors,
      trajectories: [],
      metadata: {
        total_trajectories: 0,
        complete_trajectories: 0,
        unknown_trajectories: 0,
        invalid_policy_trajectories: 0,
      },
    };
  }

  if (typeof chooseAction !== "function") {
    return {
      status: REPLAY_STATUS.POLICY_INVALID_ACTION,
      errors: ["chooseAction must be a function"],
      trajectories: [],
      metadata: {
        total_trajectories: 0,
        complete_trajectories: 0,
        unknown_trajectories: 0,
        invalid_policy_trajectories: 1,
      },
    };
  }

  // Build causal discovery tree
  const tree = buildDiscoveryTree(world);

  // Index decisions by snapshot_id (preserving factual order)
  let decisions = Array.isArray(world.decisions) ? world.decisions : [];
  if (decisions.length === 0 && Array.isArray(world.events)) {
    for (const ev of world.events) {
      if (ev?.type === "DECISION" || ev?.schema === "orchestra.decision.v1") {
        decisions.push(ev);
      }
    }
  }

  const decisionsBySnapshot = new Map();
  for (const dec of decisions) {
    if (dec && dec.snapshot_id) {
      if (!decisionsBySnapshot.has(dec.snapshot_id)) {
        decisionsBySnapshot.set(dec.snapshot_id, []);
      }
      decisionsBySnapshot.get(dec.snapshot_id).push(dec);
    }
  }

  // Memoization cache for reconstructed decision nodes: (snapshot_id, state_hash)
  const decisionNodeMemo = new Map();

  function getDecisionNode(snapshotId) {
    const decs = decisionsBySnapshot.get(snapshotId);
    if (!decs || decs.length === 0) {
      return null;
    }
    const primaryDec = decs[0];
    const stateHash = sha256Canonical(primaryDec.state || {});
    const memoKey = `${snapshotId}:${stateHash}`;

    if (decisionNodeMemo.has(memoKey)) {
      return decisionNodeMemo.get(memoKey);
    }

    const availableActionsSet = new Set();
    if (Array.isArray(primaryDec.available_actions)) {
      for (const act of primaryDec.available_actions) {
        availableActionsSet.add(act);
      }
    }
    const treeNode = tree.nodes[snapshotId];
    if (treeNode && treeNode.actions) {
      for (const act of Object.keys(treeNode.actions)) {
        availableActionsSet.add(act);
      }
    }

    const reconstructed = {
      decision_type: primaryDec.decision_type,
      state: primaryDec.state,
      available_actions: Object.freeze(Array.from(availableActionsSet)),
      state_hash: stateHash,
    };

    decisionNodeMemo.set(memoKey, reconstructed);
    return reconstructed;
  }

  const rootSnapshotId = world.root_snapshot_id;
  const completedTrajectories = [];
  const activeQueue = [
    {
      snapshot_id: rootSnapshotId,
      steps: [],
      cost_metrics: {},
      has_multi_obs: false,
      visited_snapshots: new Set([rootSnapshotId]),
    },
  ];

  let totalDerivedTrajectories = 1;

  while (activeQueue.length > 0) {
    const currentTraj = activeQueue.shift();
    const currentSnapshotId = currentTraj.snapshot_id;

    const decisionNode = getDecisionNode(currentSnapshotId);

    // If no decision node at this snapshot, this trajectory has completed
    if (!decisionNode) {
      const terminalState =
        currentTraj.steps.length > 0
          ? currentTraj.steps[currentTraj.steps.length - 1].terminal_state
          : null;

      completedTrajectories.push({
        status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
        steps: currentTraj.steps,
        terminal_state: terminalState,
        cost_metrics: currentTraj.cost_metrics,
        branch_type: currentTraj.has_multi_obs
          ? REPLAY_STATUS.REPLAY_EXACT_MULTI_OBSERVATION
          : REPLAY_STATUS.REPLAY_EXACT_SINGLE,
      });
      continue;
    }

    // Construct prefix: strictly past steps traversed so far in THIS trajectory branch.
    // Immutable frozen array without future or sibling observation data.
    const prefix = Object.freeze(
      currentTraj.steps.map((s) =>
        Object.freeze({
          snapshot_id: s.snapshot_id,
          decision_type: s.decision_type,
          chosen_action: s.chosen_action,
          observation_id: s.observation_id,
          result: s.result,
          resulting_snapshot_id: s.resulting_snapshot_id,
          terminal_state: s.terminal_state,
        })
      )
    );

    // Zero-model-call pure callback invocation
    const chosenAction = chooseAction({
      decisionType: decisionNode.decision_type,
      state: decisionNode.state,
      availableActions: [...decisionNode.available_actions],
      snapshotId: currentSnapshotId,
      prefix,
    });

    // Validate action legality against governance available_actions
    if (
      typeof chosenAction !== "string" ||
      !decisionNode.available_actions.includes(chosenAction)
    ) {
      completedTrajectories.push({
        status: REPLAY_STATUS.POLICY_INVALID_ACTION,
        steps: currentTraj.steps,
        terminal_state: null,
        cost_metrics: currentTraj.cost_metrics,
        branch_type: currentTraj.has_multi_obs
          ? REPLAY_STATUS.REPLAY_EXACT_MULTI_OBSERVATION
          : REPLAY_STATUS.REPLAY_EXACT_SINGLE,
      });
      continue;
    }

    // Query exact observations from discovery tree for snapshot_id + chosen_action
    const treeNode = tree.nodes[currentSnapshotId];
    const actionBranch = treeNode?.actions?.[chosenAction];
    const observations = actionBranch?.observations || [];

    // Exact-match invariant: unobserved actions halt immediately as UNKNOWN_BRANCH
    if (
      !actionBranch ||
      actionBranch.status === BRANCH_STATUS.UNKNOWN_BRANCH ||
      observations.length === 0
    ) {
      completedTrajectories.push({
        status: REPLAY_STATUS.UNKNOWN_BRANCH,
        steps: currentTraj.steps,
        terminal_state: null,
        cost_metrics: currentTraj.cost_metrics,
        branch_type: currentTraj.has_multi_obs
          ? REPLAY_STATUS.REPLAY_EXACT_MULTI_OBSERVATION
          : REPLAY_STATUS.REPLAY_EXACT_SINGLE,
      });
      continue;
    }

    // If multi-observation branching occurs, update totalDerivedTrajectories
    if (observations.length > 1) {
      totalDerivedTrajectories += observations.length - 1;
    }

    // Complexity ceiling: halt derivation if maximum derived trajectories exceeded
    if (totalDerivedTrajectories > maxTrajectories) {
      return {
        status: REPLAY_STATUS.REPLAY_COMPLEXITY_LIMIT,
        trajectories: [...completedTrajectories, currentTraj],
        metadata: {
          total_trajectories: totalDerivedTrajectories,
          complete_trajectories: completedTrajectories.filter(
            (t) => t.status === REPLAY_STATUS.EXACT_REPLAY_COMPLETE
          ).length,
          unknown_trajectories: completedTrajectories.filter(
            (t) => t.status === REPLAY_STATUS.UNKNOWN_BRANCH
          ).length,
          invalid_policy_trajectories: completedTrajectories.filter(
            (t) => t.status === REPLAY_STATUS.POLICY_INVALID_ACTION
          ).length,
        },
      };
    }

    // Derive trajectories for each factual observation
    for (const obs of observations) {
      const step = {
        snapshot_id: currentSnapshotId,
        decision_type: decisionNode.decision_type,
        chosen_action: chosenAction,
        observation_id: obs.observation_id,
        result: obs.result,
        resulting_snapshot_id: obs.resulting_snapshot_id ?? null,
        terminal_state: obs.terminal_state ?? null,
      };

      const newSteps = [...currentTraj.steps, step];
      const newCostMetrics = mergeCostMetrics(currentTraj.cost_metrics, obs.cost_metrics);
      const hasMulti = currentTraj.has_multi_obs || observations.length > 1;
      const nextSnapshotId = obs.resulting_snapshot_id;

      // Check whether trajectory reaches a terminal snapshot or continues
      const nextDecisionNode = nextSnapshotId ? getDecisionNode(nextSnapshotId) : null;

      if (!nextSnapshotId || !nextDecisionNode) {
        completedTrajectories.push({
          status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
          steps: newSteps,
          terminal_state: obs.terminal_state ?? null,
          cost_metrics: newCostMetrics,
          branch_type: hasMulti
            ? REPLAY_STATUS.REPLAY_EXACT_MULTI_OBSERVATION
            : REPLAY_STATUS.REPLAY_EXACT_SINGLE,
        });
      } else {
        // Cycle detection
        if (currentTraj.visited_snapshots.has(nextSnapshotId)) {
          completedTrajectories.push({
            status: REPLAY_STATUS.EXACT_REPLAY_COMPLETE,
            steps: newSteps,
            terminal_state: obs.terminal_state ?? "CYCLE_TERMINATED",
            cost_metrics: newCostMetrics,
            branch_type: hasMulti
              ? REPLAY_STATUS.REPLAY_EXACT_MULTI_OBSERVATION
              : REPLAY_STATUS.REPLAY_EXACT_SINGLE,
          });
        } else {
          const newVisited = new Set(currentTraj.visited_snapshots);
          newVisited.add(nextSnapshotId);
          activeQueue.push({
            snapshot_id: nextSnapshotId,
            steps: newSteps,
            cost_metrics: newCostMetrics,
            has_multi_obs: hasMulti,
            visited_snapshots: newVisited,
          });
        }
      }
    }
  }

  // Calculate metadata statistics
  const completeTrajectories = completedTrajectories.filter(
    (t) => t.status === REPLAY_STATUS.EXACT_REPLAY_COMPLETE
  ).length;
  const unknownTrajectories = completedTrajectories.filter(
    (t) => t.status === REPLAY_STATUS.UNKNOWN_BRANCH
  ).length;
  const invalidPolicyTrajectories = completedTrajectories.filter(
    (t) => t.status === REPLAY_STATUS.POLICY_INVALID_ACTION
  ).length;

  let overallStatus;
  if (invalidPolicyTrajectories > 0) {
    overallStatus = REPLAY_STATUS.POLICY_INVALID_ACTION;
  } else if (unknownTrajectories > 0) {
    if (completeTrajectories > 0) {
      overallStatus = REPLAY_STATUS.EXACT_REPLAY_PARTIAL;
    } else {
      overallStatus = REPLAY_STATUS.UNKNOWN_BRANCH;
    }
  } else if (completeTrajectories === completedTrajectories.length) {
    overallStatus = REPLAY_STATUS.EXACT_REPLAY_COMPLETE;
  } else {
    overallStatus = REPLAY_STATUS.EXACT_REPLAY_COMPLETE;
  }

  return {
    status: overallStatus,
    trajectories: completedTrajectories,
    metadata: {
      total_trajectories: completedTrajectories.length,
      complete_trajectories: completeTrajectories,
      unknown_trajectories: unknownTrajectories,
      invalid_policy_trajectories: invalidPolicyTrajectories,
    },
  };
}
