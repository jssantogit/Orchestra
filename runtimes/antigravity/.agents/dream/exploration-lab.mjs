import { randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync,
  readlinkSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { sha256Canonical } from "./canonical.mjs";
import { buildWorkspaceManifest } from "./snapshot.mjs";
import { buildDiscoveryTree, BRANCH_STATUS } from "./discovery-tree-builder.mjs";
import { sealWorld, validateWorld, writeSealedWorld } from "./world-sealer.mjs";

export const BRANCH_SEED_SCHEMA = "orchestra.branch-seed.v1";
export const EXPLORATION_SESSION_SCHEMA = "orchestra.exploration-session.v1";
export const EXPLORATION_ARM_SCHEMA = "orchestra.exploration-arm.v1";
export const EXPLORATION_BUDGET = Object.freeze({
  max_sibling_branches: 1,
  max_model_calls: 2,
  timeout_ms: 300000,
});

const ARM = ".agents/state/dream/exploration-arm.json";
const SESSION = ".agents/state/dream/exploration-session.json";
const CALLS = ".agents/state/dream/exploration-model-calls";
const SEEDS = ".agents/dream-data/branch-seeds";
const EXPLORATIONS = ".agents/dream-data/explorations";
const INDEX = ".agents/dream-data/explorations/index.json";

const EPHEMERAL_KEY = /(conversation(?:_?id)?|execution(?:_?id)?|correlation|role_?bindings?|pending|lock|\bpid\b|\bport\b|telemetry|timestamp|created_?at|updated_?at|started_?at|finished_?at)$/i;
const SENSITIVE_PATH = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i,
  /(^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
  /(^|\/)\.(?:npmrc|pypirc|netrc)$/i,
  /(^|\/)\.(?:ssh|aws)(?:\/|$)/i,
  /\.(?:pem|p12|pfx|key)$/i,
];
const EXTERNAL_TOOL = /(browser|web|http|url|network|deploy|publish|release|database|db_|email|mail|slack|discord|cloud|remote|mcp|plugin|connector|permission|generate_image|manage_task|ask_question)/i;
const EXPLORATION_ALLOWED_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "edit_file",
  "create_file",
  "invoke_subagent",
  "define_subagent",
  "run_command",
  "view_file",
  "grep_search",
  "find_by_name",
  "manage_subagents",
]);

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + process.pid + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  renameSync(temp, path);
}
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function severity(value) { return String(value || "NORMAL").trim().toUpperCase(); }
function decisionType(value) { return String(value || "").trim().toUpperCase(); }
function sensitive(path) { return SENSITIVE_PATH.some((re) => re.test(String(path || ""))); }
function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function stripEphemeral(value) {
  if (Array.isArray(value)) return value.map(stripEphemeral);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (!EPHEMERAL_KEY.test(key)) out[key] = stripEphemeral(child);
  }
  return out;
}
function ephemeralKeys(value, prefix = "") {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((child, i) => ephemeralKeys(child, prefix + "[" + i + "]"));
  const found = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? prefix + "." + key : key;
    if (EPHEMERAL_KEY.test(key)) found.push(path);
    else found.push(...ephemeralKeys(child, path));
  }
  return found;
}
function rawToolPath(toolName, args = {}) {
  if (toolName === "view_file") {
    return args.AbsolutePath || args.absolutePath || args.FilePath || args.filePath || args.path || "";
  }
  if (toolName === "grep_search") {
    return args.SearchPath || args.searchPath || args.Directory || args.directory || args.path || "";
  }
  if (toolName === "find_by_name") {
    return args.SearchDirectory || args.searchDirectory || args.Directory || args.directory || args.path || "";
  }
  if (["write_to_file", "replace_file_content", "edit_file", "create_file"].includes(toolName)) {
    return args.TargetFile || args.targetFile || args.FilePath || args.filePath || args.path || "";
  }
  return "";
}

function explorationPathConfined(repoRoot, rawPath) {
  if (!rawPath) return true;
  const cleaned = String(rawPath).trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return true;

  const lexical = resolve(repoRoot, cleaned);
  if (!inside(repoRoot, lexical)) return false;

  let physicalRoot = resolve(repoRoot);
  try { physicalRoot = realpathSync(repoRoot); } catch {}

  if (existsSync(lexical)) {
    try {
      return inside(physicalRoot, realpathSync(lexical));
    } catch {
      return false;
    }
  }

  // For non-existing mutation targets, resolve the deepest existing ancestor
  // so a symlinked parent cannot escape the sibling.
  let ancestor = lexical;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  try {
    return inside(physicalRoot, realpathSync(ancestor));
  } catch {
    return false;
  }
}

function reserveSiblingSlot(repoRoot, key) {
  const reservationDir = resolve(repoRoot, EXPLORATIONS, "reservations");
  mkdirSync(reservationDir, { recursive: true });
  const token = String(key || "").replace(/^sha256:/, "");
  const path = resolve(reservationDir, token + ".json");
  try {
    writeFileSync(path, JSON.stringify({
      schema: "orchestra.exploration-reservation.v1",
      key,
      reserved_at: new Date().toISOString(),
    }), { encoding: "utf8", flag: "wx" });
    return { reserved: true, path };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { reserved: false, reason: "SIBLING_LIMIT_REACHED", path };
    }
    return {
      reserved: false,
      reason: "EXPLORATION_RESERVATION_FAILED",
      error: String(error?.message || error),
    };
  }
}

function commandFrom(args = {}) {
  for (const key of ["CommandLine", "command", "Command", "cmd", "shell_command", "script"]) {
    if (typeof args[key] === "string" && args[key].trim()) return args[key].trim();
  }
  return "";
}
function copyWorkspace(repoRoot, manifest, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of manifest) {
    const src = resolve(repoRoot, entry.path);
    const dst = resolve(destination, entry.path);
    if (!inside(destination, dst)) throw new Error("SEED_PATH_ESCAPE:" + entry.path);
    mkdirSync(dirname(dst), { recursive: true });
    if (entry.type === "file") {
      copyFileSync(src, dst);
      if (entry.executable) chmodSync(dst, 0o755);
    } else if (entry.type === "symlink") {
      symlinkSync(readlinkSync(src), dst);
    }
  }
}
function worldDecisions(world) {
  if (Array.isArray(world?.decisions) && world.decisions.length) return world.decisions;
  return (world?.events || []).filter((e) => e?.type === "DECISION" || e?.schema === "orchestra.decision.v1");
}
function loadIndex(repoRoot) {
  const path = resolve(repoRoot, INDEX);
  if (!existsSync(path)) return { schema: "orchestra.exploration-index.v1", entries: {} };
  try {
    const value = readJson(path);
    if (value?.schema === "orchestra.exploration-index.v1" && value.entries) return value;
  } catch {}
  return { schema: "orchestra.exploration-index.v1", entries: {} };
}
function activateExplorationPreToolWrapper(branchRoot) {
  const hooksPath = resolve(branchRoot, ".agents/hooks.json");
  if (!existsSync(hooksPath)) {
    return { ok: false, reason: "EXPLORATION_HOOK_CONFIG_MISSING" };
  }

  let config;
  try {
    config = readJson(hooksPath);
  } catch (error) {
    return { ok: false, reason: "EXPLORATION_HOOK_CONFIG_INVALID", error: error.message };
  }

  const entry = config?.["scope-enforcer"]?.PreToolUse?.[0];
  const handler = entry?.hooks?.[0];
  if (!entry || !handler || typeof handler.command !== "string") {
    return { ok: false, reason: "EXPLORATION_HOOK_TOPOLOGY_INVALID" };
  }
  if (
    !existsSync(resolve(branchRoot, ".agents/hooks/pre-tool-enforce.mjs")) ||
    !existsSync(resolve(branchRoot, ".agents/hooks/pre-tool-exploration-guard.mjs")) ||
    !existsSync(resolve(branchRoot, ".agents/hooks/post-invocation-exploration-guard.mjs"))
  ) {
    return { ok: false, reason: "EXPLORATION_HOOK_IMPLEMENTATION_MISSING" };
  }

  const original = {
    matcher: entry.matcher || null,
    command: handler.command,
  };
  entry.matcher = "*";
  handler.command = "node hooks/pre-tool-exploration-guard.mjs";
  config["exploration-budget-guard"] = {
    PostInvocation: [{
      type: "command",
      command: "node hooks/post-invocation-exploration-guard.mjs",
      timeout: 10,
    }],
  };
  atomicJson(hooksPath, config);
  return {
    ok: true,
    original,
    overlay_hash: sha256Canonical({
      pre_tool_matcher: entry.matcher,
      pre_tool_command: handler.command,
      post_invocation_command: config["exploration-budget-guard"].PostInvocation[0].command,
      original,
    }),
  };
}

function activeStateFromSeed(seed, sessionId) {
  const s = seed.decision.state || {};
  return {
    state: s.state || "EXECUTING",
    taskSpec: seed.task_descriptor?.spec || "Exploration branch",
    taskAction: s.task_action || seed.task_descriptor?.task_action || "IMPLEMENT",
    taskDomain: s.task_domain || seed.task_descriptor?.task_domain || "CODE",
    criticality: s.criticality || "NORMAL",
    complexity: s.complexity || "NORMAL",
    attempt: s.attempt ?? 0,
    retry_remaining: s.retry_remaining ?? 0,
    remainingAttempts: s.retry_remaining ?? 0,
    retryReason: s.retry_reason || null,
    mutationSeq: s.mutation_seq ?? 0,
    postInvestigation: Boolean(s.post_investigation),
    post_investigation: Boolean(s.post_investigation),
    evidenceSummary: seed.evidence_summary || {},
    explorationSessionId: sessionId,
  };
}

export function isSafeExplorationCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd || /[;&|\`$<>\n\r]/.test(cmd)) return false;
  const norm = cmd.replace(/\s+/g, " ");
  return /^git (?:status|diff|show|log|rev-parse)(?:\s|$)/.test(norm)
    || /^git branch --show-current$/.test(norm)
    || /^node --check (?!-)(?:[^\s]+)(?:\s+[^\s]+)*$/.test(norm)
    || /^node --test(?:\s|$)/.test(norm);
}

export function armExplorationCapture({ repoRoot, decisionType: type = null, approveMajor = false } = {}) {
  if (!repoRoot) return { armed: false, reason: "MISSING_REPO_ROOT" };
  const path = resolve(repoRoot, ARM);
  const arm = {
    schema: EXPLORATION_ARM_SCHEMA,
    arm_id: "arm-" + randomUUID(),
    decision_type: type ? decisionType(type) : null,
    approve_major: approveMajor === true,
    created_at: new Date().toISOString(),
  };
  atomicJson(path, arm);
  return { armed: true, path, arm };
}
export function readExplorationArm(repoRoot) {
  const path = resolve(repoRoot, ARM);
  if (!existsSync(path)) return null;
  try {
    const value = readJson(path);
    return value?.schema === EXPLORATION_ARM_SCHEMA ? value : null;
  } catch { return null; }
}
function consumeArm(repoRoot) { try { unlinkSync(resolve(repoRoot, ARM)); } catch {} }

export function captureBranchSeedIfArmed({
  repoRoot, snapshot, decisionType: type, decisionState, availableActions,
  scopeContract, taskDescriptor = {}, evidenceSummary = {}, runtimeState = {},
} = {}) {
  const arm = readExplorationArm(repoRoot);
  if (!arm) return { captured: false, reason: "NOT_ARMED" };
  const typeNorm = decisionType(type);
  if (arm.decision_type && arm.decision_type !== typeNorm) {
    return { captured: false, reason: "ARM_TARGET_MISMATCH" };
  }
  const criticality = severity(decisionState?.criticality ?? scopeContract?.criticality);
  if (criticality === "CRITICAL") { consumeArm(repoRoot); return { captured: false, reason: "EXPLORATION_INELIGIBLE_CRITICAL" }; }
  if (criticality === "MAJOR" && !arm.approve_major) { consumeArm(repoRoot); return { captured: false, reason: "EXPLORATION_INELIGIBLE_MAJOR_REQUIRES_APPROVAL" }; }
  if (runtimeState?.state === "HUMAN_GATE" || runtimeState?.humanGateRequired) { consumeArm(repoRoot); return { captured: false, reason: "EXPLORATION_INELIGIBLE_HUMAN_GATE" }; }
  if (!snapshot?.snapshot_id || !snapshot?.workspace_fingerprint) { consumeArm(repoRoot); return { captured: false, reason: "EXPLORATION_SEED_SNAPSHOT_INVALID" }; }
  if (!Array.isArray(availableActions) || availableActions.length < 2) { consumeArm(repoRoot); return { captured: false, reason: "EXPLORATION_NO_ALTERNATIVE_ACTION" }; }
  const ephemeral = ephemeralKeys(scopeContract || {});
  if (ephemeral.length) { consumeArm(repoRoot); return { captured: false, reason: "BRANCH_SEED_EPHEMERAL_CONTRACT_UNSAFE", paths: ephemeral }; }

  const manifestResult = buildWorkspaceManifest(repoRoot);
  if (!manifestResult.ok) { consumeArm(repoRoot); return { captured: false, reason: manifestResult.reason }; }
  if (sha256Canonical(manifestResult.manifest) !== snapshot.workspace_fingerprint) {
    consumeArm(repoRoot); return { captured: false, reason: "BRANCH_SEED_SNAPSHOT_DRIFT" };
  }
  const unsafe = manifestResult.manifest.find((entry) => sensitive(entry.path));
  if (unsafe) { consumeArm(repoRoot); return { captured: false, reason: "BRANCH_SEED_SECRET_PATH_UNSAFE", path: unsafe.path }; }

  const cleanState = stripEphemeral(decisionState || {});
  const stateHash = sha256Canonical(cleanState);
  const seedId = "seed-" + sha256Canonical({
    snapshot_id: snapshot.snapshot_id,
    decision_type: typeNorm,
    state_hash: stateHash,
    actions: [...availableActions].sort(),
  }).slice(7);
  const seedDir = resolve(repoRoot, SEEDS, seedId);
  const workspace = resolve(seedDir, "workspace");
  rmSync(seedDir, { recursive: true, force: true });
  copyWorkspace(repoRoot, manifestResult.manifest, workspace);

  const seed = {
    schema: BRANCH_SEED_SCHEMA,
    seed_id: seedId,
    snapshot: stripEphemeral(snapshot),
    decision: {
      decision_type: typeNorm,
      state: cleanState,
      state_hash: stateHash,
      available_actions: [...availableActions],
    },
    scope_contract: structuredClone(scopeContract || {}),
    task_descriptor: structuredClone(taskDescriptor || {}),
    evidence_summary: stripEphemeral(evidenceSummary || {}),
    runtime_fingerprint: snapshot.runtime_fingerprint,
    human_approved_major: criticality === "MAJOR" && arm.approve_major === true,
    workspace_manifest: manifestResult.manifest,
    archive_workspace_relative: "workspace",
    captured_at: new Date().toISOString(),
  };
  atomicJson(resolve(seedDir, "branch-seed.json"), seed);
  consumeArm(repoRoot);
  return { captured: true, seed_id: seedId, seed_path: resolve(seedDir, "branch-seed.json") };
}

export function selectLeastObservedLegalAction({ tree, snapshotId, availableActions } = {}) {
  if (!tree?.nodes?.[snapshotId]) return { selected: null, reason: "DISCOVERY_SNAPSHOT_NOT_FOUND" };
  const ranked = [...new Set(availableActions || [])].map((action) => {
    const branch = tree.nodes[snapshotId]?.actions?.[action];
    return {
      action,
      observations: Array.isArray(branch?.observations) ? branch.observations.length : 0,
      status: branch?.status || BRANCH_STATUS.UNKNOWN_BRANCH,
    };
  }).sort((a, b) => a.observations - b.observations || a.action.localeCompare(b.action));
  if (!ranked.length) return { selected: null, reason: "NO_LEGAL_ACTIONS" };
  if (ranked[0].observations !== 0) return { selected: null, reason: "NO_UNKNOWN_BRANCH", ranked };
  return { selected: ranked[0].action, reason: "LEAST_OBSERVED_LEGAL_ACTION", ranked };
}

export function prepareExploration({ repoRoot, seedPath, world, decisionId = null } = {}) {
  if (!repoRoot || !seedPath || !world) return { prepared: false, reason: "MISSING_PREPARE_INPUT" };
  const valid = validateWorld(world);
  if (!valid.valid) return { prepared: false, reason: "WORLD_INVALID", errors: valid.errors };
  let seed;
  try { seed = readJson(seedPath); } catch (error) { return { prepared: false, reason: "EXPLORATION_SEED_UNAVAILABLE", error: error.message }; }
  if (seed?.schema !== BRANCH_SEED_SCHEMA) return { prepared: false, reason: "BRANCH_SEED_INVALID" };
  if (!seed.decision || !seed.snapshot || !Array.isArray(seed.workspace_manifest)) {
    return { prepared: false, reason: "BRANCH_SEED_INVALID" };
  }
  if (sha256Canonical(seed.decision.state || {}) !== seed.decision.state_hash) {
    return { prepared: false, reason: "BRANCH_SEED_STATE_HASH_MISMATCH" };
  }
  if (sha256Canonical(seed.workspace_manifest) !== seed.snapshot.workspace_fingerprint) {
    return { prepared: false, reason: "BRANCH_SEED_MANIFEST_HASH_MISMATCH" };
  }
  if (seed.workspace_manifest.some((entry) => sensitive(entry?.path))) {
    return { prepared: false, reason: "BRANCH_SEED_SECRET_PATH_UNSAFE" };
  }

  const candidates = worldDecisions(world).filter((d) =>
    d?.snapshot_id === seed.snapshot?.snapshot_id
    && decisionType(d?.decision_type) === seed.decision?.decision_type
    && sha256Canonical(stripEphemeral(d?.state || {})) === seed.decision?.state_hash
    && (!decisionId || d?.decision_id === decisionId)
  );
  if (candidates.length !== 1) return { prepared: false, reason: candidates.length ? "SOURCE_DECISION_AMBIGUOUS" : "SOURCE_DECISION_NOT_FOUND" };
  const source = candidates[0];
  const sourceCriticality = severity(source.state?.criticality);
  if (sourceCriticality === "CRITICAL") return { prepared: false, reason: "EXPLORATION_INELIGIBLE_CRITICAL" };
  if (sourceCriticality === "MAJOR" && seed.human_approved_major !== true) {
    return { prepared: false, reason: "EXPLORATION_INELIGIBLE_MAJOR_REQUIRES_APPROVAL" };
  }
  if (source.state?.state === "HUMAN_GATE" || source.state?.human_gate_active) return { prepared: false, reason: "EXPLORATION_INELIGIBLE_HUMAN_GATE" };
  const sourceActionsHash = sha256Canonical([...new Set(source.available_actions || [])].sort());
  const seedActionsHash = sha256Canonical([...new Set(seed.decision.available_actions || [])].sort());
  if (sourceActionsHash !== seedActionsHash) {
    return { prepared: false, reason: "BRANCH_SEED_ACTION_SPACE_MISMATCH" };
  }

  const tree = buildDiscoveryTree(world);
  const selection = selectLeastObservedLegalAction({ tree, snapshotId: source.snapshot_id, availableActions: source.available_actions });
  if (!selection.selected) return { prepared: false, reason: selection.reason, ranked: selection.ranked };

  const key = sha256Canonical({
    decision_id: source.decision_id,
    snapshot_id: source.snapshot_id,
    decision_type: source.decision_type,
    state_hash: seed.decision.state_hash,
  });
  const index = loadIndex(repoRoot);
  if (index.entries[key]) return { prepared: false, reason: "SIBLING_LIMIT_REACHED", existing: index.entries[key] };

  const primary = buildWorkspaceManifest(repoRoot);
  if (!primary.ok) return { prepared: false, reason: primary.reason };
  const primaryFingerprint = sha256Canonical(primary.manifest);
  const archive = resolve(dirname(resolve(seedPath)), seed.archive_workspace_relative || "workspace");
  if (!existsSync(archive)) return { prepared: false, reason: "BRANCH_SEED_PAYLOAD_MISSING" };
  const archiveManifest = buildWorkspaceManifest(archive);
  if (!archiveManifest.ok) return { prepared: false, reason: archiveManifest.reason };
  if (sha256Canonical(archiveManifest.manifest) !== seed.snapshot.workspace_fingerprint) {
    return { prepared: false, reason: "BRANCH_SEED_PAYLOAD_HASH_MISMATCH" };
  }

  // Reserve the single sibling slot with O_EXCL semantics before materializing
  // anything. The durable reservation makes the hard budget race-safe across
  // concurrent prepare processes.
  const reservation = reserveSiblingSlot(repoRoot, key);
  if (!reservation.reserved) {
    return {
      prepared: false,
      reason: reservation.reason,
      reservation_path: reservation.path || null,
      error: reservation.error || null,
    };
  }

  const sessionId = "explore-" + randomUUID();
  const branchRoot = join(tmpdir(), "orchestra-dream-" + sessionId.replace(/[^A-Za-z0-9._-]/g, "-"));
  let indexCommitted = false;

  try {
    rmSync(branchRoot, { recursive: true, force: true });
    cpSync(archive, branchRoot, { recursive: true, dereference: false });
    const now = Date.now();
    const session = {
      schema: EXPLORATION_SESSION_SCHEMA,
      session_id: sessionId,
      mode: "EXPLICIT_LOCAL",
      source: {
        world_id: world.world_id,
        seed_id: seed.seed_id,
        snapshot_id: source.snapshot_id,
        decision_type: source.decision_type,
        state_hash: seed.decision.state_hash,
      },
      target: {
        decision_type: source.decision_type,
        state_hash: seed.decision.state_hash,
        selected_action: selection.selected,
        available_actions: [...source.available_actions],
        selection_rule: "LEAST_OBSERVED_LEGAL_ACTION",
      },
      budget: { ...EXPLORATION_BUDGET },
      runtime_fingerprint: seed.runtime_fingerprint,
      primary_workspace_fingerprint: primaryFingerprint,
      status: "PREPARED",
      created_at: new Date(now).toISOString(),
      deadline_at: new Date(now + EXPLORATION_BUDGET.timeout_ms).toISOString(),
    };

    mkdirSync(resolve(branchRoot, ".agents/state/dream"), { recursive: true });
    mkdirSync(resolve(branchRoot, ".agents/telemetry"), { recursive: true });
    writeFileSync(resolve(branchRoot, ".agents/telemetry/events.jsonl"), "", "utf8");
    atomicJson(resolve(branchRoot, ".agents/state/active-state.json"), activeStateFromSeed(seed, sessionId));
    atomicJson(resolve(branchRoot, ".agents/state/active-contract.json"), seed.scope_contract);
    atomicJson(resolve(branchRoot, SESSION), session);

    const hookOverlay = activateExplorationPreToolWrapper(branchRoot);
    if (!hookOverlay.ok) {
      rmSync(branchRoot, { recursive: true, force: true });
      try { unlinkSync(reservation.path); } catch {}
      return { prepared: false, reason: hookOverlay.reason, error: hookOverlay.error || null };
    }
    session.hook_overlay = {
      mode: "EXPLORATION_PRETOOL_WRAPPER",
      overlay_hash: hookOverlay.overlay_hash,
      original_matcher: hookOverlay.original.matcher,
      original_command: hookOverlay.original.command,
    };
    atomicJson(resolve(branchRoot, SESSION), session);

    mkdirSync(resolve(repoRoot, EXPLORATIONS), { recursive: true });
    atomicJson(resolve(repoRoot, EXPLORATIONS, sessionId + ".json"), { ...session, branch_workspace: branchRoot });
    index.entries[key] = {
      session_id: sessionId,
      source_world_id: world.world_id,
      source_decision_id: source.decision_id,
      source_snapshot_id: source.snapshot_id,
      selected_action: selection.selected,
      created_at: session.created_at,
    };
    atomicJson(resolve(repoRoot, INDEX), index);
    indexCommitted = true;

    try {
      writeFileSync(reservation.path, JSON.stringify({
        schema: "orchestra.exploration-reservation.v1",
        key,
        status: "MATERIALIZED",
        session_id: sessionId,
        branch_workspace: branchRoot,
        selected_action: selection.selected,
        materialized_at: new Date().toISOString(),
      }, null, 2), "utf8");
    } catch {
      // Reservation already exists and therefore still enforces the hard
      // sibling ceiling even if this descriptive metadata update fails.
    }

    return { prepared: true, session, branch_workspace: branchRoot, selection };
  } catch (error) {
    try { rmSync(branchRoot, { recursive: true, force: true }); } catch {}
    if (!indexCommitted) {
      try { unlinkSync(reservation.path); } catch {}
    }
    return {
      prepared: false,
      reason: "EXPLORATION_MATERIALIZATION_FAILED",
      error: String(error?.message || error),
    };
  }
}

export function loadExplorationSession(repoRoot) {
  const path = resolve(repoRoot, SESSION);
  if (!existsSync(path)) return null;
  try {
    const value = readJson(path);
    return value?.schema === EXPLORATION_SESSION_SCHEMA ? value : null;
  } catch { return null; }
}

export function resolveExplorationPolicyOverlay({ repoRoot, decisionType: type, state, availableActions, baselineAction } = {}) {
  const session = loadExplorationSession(repoRoot);
  if (!session) return null;
  if (!["PREPARED", "RUNNING"].includes(session.status)) return { active: true, blocked: true, reason: "EXPLORATION_SESSION_NOT_ACTIVE" };
  if (session.target?.consumed === true) return null;
  if (Date.now() > Date.parse(session.deadline_at)) return { active: true, blocked: true, reason: "EXPLORATION_TIMEOUT" };
  if (decisionType(type) !== decisionType(session.target?.decision_type)) return null;
  if (sha256Canonical(stripEphemeral(state || {})) !== session.target?.state_hash) return null;
  const action = session.target?.selected_action;
  if (!Array.isArray(availableActions) || !availableActions.includes(action)) {
    return { active: true, blocked: true, reason: "EXPLORATION_TARGET_ILLEGAL_ACTION" };
  }
  return {
    active: true,
    blocked: false,
    ok: true,
    action,
    source: "EXPLORATION_LAB",
    policy_id: "exploration:" + session.session_id,
    baseline_action: baselineAction || null,
    policy_diagnostic: null,
    source_snapshot_id: session.source?.snapshot_id || null,
  };
}

export function consumeExplorationTarget({ repoRoot, decisionType: type, state, action } = {}) {
  const session = loadExplorationSession(repoRoot);
  if (!session || !["PREPARED", "RUNNING"].includes(session.status)) {
    return { consumed: false, reason: "EXPLORATION_SESSION_NOT_ACTIVE" };
  }
  if (session.target?.consumed === true) {
    return { consumed: false, reason: "EXPLORATION_TARGET_ALREADY_CONSUMED" };
  }

  const typeMatches = decisionType(type) === decisionType(session.target?.decision_type);
  const stateMatches = sha256Canonical(stripEphemeral(state || {})) === session.target?.state_hash;
  const actionMatches = String(action || "") === String(session.target?.selected_action || "");
  if (!typeMatches || !stateMatches || !actionMatches) {
    return { consumed: false, reason: "EXPLORATION_TARGET_MISMATCH" };
  }

  session.target.consumed = true;
  session.target.consumed_at = new Date().toISOString();
  atomicJson(resolve(repoRoot, SESSION), session);
  return { consumed: true, session_id: session.session_id };
}

export function enforceExplorationToolBoundary({ repoRoot, toolName, toolArgs = {} } = {}) {
  const session = loadExplorationSession(repoRoot);
  if (!session) return { active: false, allowed: true };
  if (!["PREPARED", "RUNNING"].includes(session.status)) return { active: true, allowed: false, reason: "EXPLORATION_SESSION_NOT_ACTIVE" };
  if (Date.now() > Date.parse(session.deadline_at)) return { active: true, allowed: false, reason: "EXPLORATION_TIMEOUT" };
  const name = String(toolName || "");
  if (name === "schedule" || name === "send_message" || EXTERNAL_TOOL.test(name)) {
    return { active: true, allowed: false, reason: "EXPLORATION_EXTERNAL_SIDE_EFFECT_BLOCKED:" + name };
  }
  if (!EXPLORATION_ALLOWED_TOOLS.has(name)) {
    return { active: true, allowed: false, reason: "EXPLORATION_TOOL_NOT_ALLOWLISTED:" + name };
  }

  const rawPath = rawToolPath(name, toolArgs);
  if (rawPath && !explorationPathConfined(repoRoot, rawPath)) {
    return {
      active: true,
      allowed: false,
      reason: "EXPLORATION_WORKSPACE_ESCAPE:" + String(rawPath),
    };
  }

  if (name === "invoke_subagent") {
    const subagents = toolArgs.Subagents || toolArgs.subagents || [];
    if (!Array.isArray(subagents) || subagents.length !== 1) {
      return { active: true, allowed: false, reason: "EXPLORATION_PARALLEL_SUBAGENT_BLOCKED" };
    }
  }
  if (name === "run_command" && !isSafeExplorationCommand(commandFrom(toolArgs))) {
    return { active: true, allowed: false, reason: "EXPLORATION_COMMAND_NOT_ALLOWLISTED" };
  }
  return { active: true, allowed: true };
}

export function getExplorationBudgetState(repoRoot) {
  const session = loadExplorationSession(repoRoot);
  if (!session) {
    return { active: false, exhausted: false, timed_out: false, model_calls: 0 };
  }

  const callDir = resolve(repoRoot, CALLS);
  const modelCalls = existsSync(callDir)
    ? readdirSync(callDir).filter((name) => name.endsWith(".json")).length
    : 0;
  const timedOut = Date.now() >= Date.parse(session.deadline_at);
  const exhausted = timedOut || modelCalls >= EXPLORATION_BUDGET.max_model_calls;
  return {
    active: ["PREPARED", "RUNNING"].includes(session.status),
    exhausted,
    timed_out: timedOut,
    model_calls: modelCalls,
    session_id: session.session_id,
  };
}

export function recordExplorationModelCall({ repoRoot, payload = {} } = {}) {
  const session = loadExplorationSession(repoRoot);
  if (!session) return { active: false, terminate: false, model_calls: 0 };

  if (!Number.isInteger(payload.invocationNum) || payload.invocationNum < 0) {
    return {
      active: true,
      terminate: true,
      reason: "EXPLORATION_INVOCATION_IDENTITY_MISSING",
      model_calls: null,
    };
  }

  const dir = resolve(repoRoot, CALLS);
  mkdirSync(dir, { recursive: true });
  const id = sha256Canonical({
    session_id: session.session_id,
    conversation_id: payload.conversationId || null,
    invocation_num: payload.invocationNum,
    model_name: payload.modelName || null,
  }).slice(7);
  const marker = resolve(dir, id + ".json");
  if (!existsSync(marker)) {
    try {
      writeFileSync(marker, JSON.stringify({
        session_id: session.session_id,
        conversation_id: payload.conversationId || null,
        invocation_num: payload.invocationNum,
      }), { encoding: "utf8", flag: "wx" });
    } catch {}
  }
  const calls = readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  const timedOut = Date.now() >= Date.parse(session.deadline_at);
  const terminate = timedOut || calls >= EXPLORATION_BUDGET.max_model_calls;
  return {
    active: true,
    terminate,
    reason: timedOut ? "EXPLORATION_TIMEOUT" : terminate ? "EXPLORATION_MODEL_CALL_BUDGET_EXHAUSTED" : null,
    model_calls: calls,
  };
}

export function buildSandboxedExplorationCommand(command, args = []) {
  const raw = String(command || "").trim();
  const executable = raw.toLowerCase();
  if (
    raw.includes("/") ||
    raw.includes("\\") ||
    !["agy", "agy.exe", "antigravity", "antigravity.exe"].includes(executable)
  ) {
    return { ok: false, reason: "EXPLORATION_RUNNER_REQUIRES_ANTIGRAVITY" };
  }

  const normalizedArgs = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  const forbidden = normalizedArgs.find((arg) => {
    const value = arg.trim().toLowerCase();
    return value === "--dangerously-skip-permissions"
      || value === "--no-sandbox"
      || value === "--sandbox=false"
      || value.startsWith("--sandbox=false")
      || value.startsWith("--permission-mode")
      || value.startsWith("--tool-permission=always-proceed");
  });
  if (forbidden) {
    return {
      ok: false,
      reason: "EXPLORATION_SANDBOX_BYPASS_FORBIDDEN",
      argument: forbidden,
    };
  }

  const withoutSandbox = normalizedArgs.filter((arg) => arg.trim().toLowerCase() !== "--sandbox");
  return {
    ok: true,
    command: raw,
    args: ["--sandbox", ...withoutSandbox],
  };
}

function resolveAntigravityExecutable(command, branchWorkspace, env = process.env) {
  const raw = String(command || "").trim().toLowerCase();
  const pathEntries = String(env.PATH || "").split(delimiter).filter(Boolean);
  const names = process.platform === "win32"
    ? (
      raw.endsWith(".exe")
        ? [raw]
        : [raw + ".exe", raw + ".cmd", raw + ".bat"]
    )
    : [raw];

  for (const entry of pathEntries) {
    if (!isAbsolute(entry)) continue;
    for (const name of names) {
      const candidate = resolve(entry, name);
      if (!existsSync(candidate)) continue;
      let physical = candidate;
      try { physical = realpathSync(candidate); } catch {}
      if (inside(branchWorkspace, physical)) continue;
      return physical;
    }
  }
  return null;
}

export function runExplorationCommand({ branchWorkspace, command, args = [] } = {}) {
  if (!branchWorkspace || !command) return { ran: false, reason: "MISSING_RUN_INPUT" };
  const session = loadExplorationSession(branchWorkspace);
  if (!session) return { ran: false, reason: "EXPLORATION_SESSION_MISSING" };
  if (session.status !== "PREPARED") {
    return { ran: false, reason: "EXPLORATION_SESSION_NOT_RUNNABLE", status: session.status };
  }
  if (Date.now() >= Date.parse(session.deadline_at)) {
    session.status = "TIMEOUT";
    session.finished_at = new Date().toISOString();
    atomicJson(resolve(branchWorkspace, SESSION), session);
    return { ran: false, reason: "EXPLORATION_TIMEOUT", timed_out: true };
  }

  const launch = buildSandboxedExplorationCommand(command, args);
  if (!launch.ok) return { ran: false, ...launch };

  const executablePath = resolveAntigravityExecutable(launch.command, branchWorkspace);
  if (!executablePath) {
    return { ran: false, reason: "EXPLORATION_ANTIGRAVITY_EXECUTABLE_NOT_FOUND" };
  }

  const remaining = Date.parse(session.deadline_at) - Date.now();
  session.status = "RUNNING";
  session.runner = {
    executable: executablePath,
    sandbox_forced: true,
    permission_bypass_allowed: false,
  };
  atomicJson(resolve(branchWorkspace, SESSION), session);

  const result = spawnSync(executablePath, launch.args, {
    cwd: branchWorkspace,
    stdio: "inherit",
    timeout: Math.min(remaining, EXPLORATION_BUDGET.timeout_ms),
    env: {
      ...process.env,
      ORCHESTRA_DREAM_EXPLORATION: "1",
      ORCHESTRA_DREAM_EXPLORATION_SESSION: session.session_id,
      ORCHESTRA_DREAM_SANDBOX_REQUIRED: "1",
    },
  });
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
  const spawnError = result.error ? String(result.error.message || result.error) : null;
  const latest = loadExplorationSession(branchWorkspace) || session;
  latest.status = timedOut ? "TIMEOUT" : spawnError ? "FAILED_TO_START" : "FINISHED";
  latest.finished_at = new Date().toISOString();
  latest.exit_code = result.status;
  latest.signal = result.signal || null;
  latest.spawn_error = spawnError;
  atomicJson(resolve(branchWorkspace, SESSION), latest);
  return {
    ran: !spawnError,
    reason: spawnError ? "EXPLORATION_SPAWN_FAILED" : null,
    timed_out: timedOut,
    exit_code: result.status,
    signal: result.signal || null,
    sandbox_forced: true,
    spawn_error: spawnError,
  };
}

export function collectExplorationResult({ primaryRepoRoot, branchWorkspace } = {}) {
  if (!primaryRepoRoot || !branchWorkspace) return { collected: false, reason: "MISSING_COLLECT_INPUT" };
  const session = loadExplorationSession(branchWorkspace);
  if (!session) return { collected: false, reason: "EXPLORATION_SESSION_MISSING" };
  if (session.status !== "FINISHED") {
    return {
      collected: false,
      reason: "EXPLORATION_SESSION_NOT_COLLECTABLE",
      status: session.status,
    };
  }
  const callDir = resolve(branchWorkspace, CALLS);
  const calls = existsSync(callDir) ? readdirSync(callDir).filter((n) => n.endsWith(".json")).length : 0;
  if (calls > EXPLORATION_BUDGET.max_model_calls) return { collected: false, reason: "EXPLORATION_MODEL_CALL_BUDGET_EXCEEDED", model_calls: calls };

  const primary = buildWorkspaceManifest(primaryRepoRoot);
  if (!primary.ok) return { collected: false, reason: primary.reason };
  if (sha256Canonical(primary.manifest) !== session.primary_workspace_fingerprint) {
    return { collected: false, reason: "PRIMARY_WORKSPACE_CHANGED_DURING_EXPLORATION" };
  }
  const sealed = sealWorld({
    repoRoot: branchWorkspace,
    rootSnapshotId: session.source.snapshot_id,
    expectedRuntimeFingerprint: session.runtime_fingerprint,
  });
  if (sealed.status !== "SEALED" || !sealed.world) return { collected: false, reason: sealed.status, errors: sealed.errors || [] };
  const written = writeSealedWorld(primaryRepoRoot, sealed.world);
  if (!written.written) return { collected: false, reason: written.reason || "WORLD_WRITE_FAILED", errors: written.errors || [] };
  return { collected: true, world_id: sealed.world.world_id, path: written.path, model_calls: calls };
}
