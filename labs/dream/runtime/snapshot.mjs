import { createHash } from "node:crypto";
import {
  openSync,
  readSync,
  closeSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, dirname, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { canonicalize, sha256Canonical } from "./canonical.mjs";
import { DREAM_SCHEMAS, validateDreamRecord } from "./records.mjs";

const DEFAULT_EXCLUDED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".pytest_cache",
  "__pycache__",
  "tmp",
  "temp",
  "scratch",
  "raw-before",
  "raw-after",
]);

const DEFAULT_EXCLUDED_PREFIXES = [
  ".agents/state",
  ".agents/telemetry",
  ".agents/artifacts",
  ".agents/dream-data",
];

const DEFAULT_ENV_ALLOWLIST = Object.freeze([
  "CI",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NODE_OPTIONS",
]);

/**
 * Normalizes CRLF -> LF and trims trailing whitespace per line.
 * Preserves leading indentation and blank line structure.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeTaskSpec(text) {
  if (typeof text !== "string") {
    return "";
  }
  const lines = text.split(/\r\n|\r|\n/);
  const normalized = lines.map((line) => line.replace(/[ \t\f\v]+$/, ""));
  return normalized.join("\n");
}

/**
 * Streaming SHA-256 computation over a file. Never loads entire file into memory.
 *
 * @param {string} filePath
 * @returns {string} Formatted as "sha256:<64-char-hex>"
 */
function hashFileSync(filePath) {
  const fd = openSync(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Checks if a relative POSIX path matches any deterministic or custom exclusions.
 *
 * @param {string} relPosixPath
 * @param {string} baseName
 * @param {Array<string | RegExp>} [customPatterns]
 * @returns {boolean}
 */
function isExcluded(relPosixPath, baseName, customPatterns = []) {
  if (DEFAULT_EXCLUDED_NAMES.has(baseName)) {
    return true;
  }
  for (const prefix of DEFAULT_EXCLUDED_PREFIXES) {
    if (relPosixPath === prefix || relPosixPath.startsWith(prefix + "/")) {
      return true;
    }
  }
  const segments = relPosixPath.split("/");
  for (const seg of segments) {
    if (DEFAULT_EXCLUDED_NAMES.has(seg)) {
      return true;
    }
  }
  if (Array.isArray(customPatterns)) {
    for (const pattern of customPatterns) {
      if (pattern instanceof RegExp) {
        if (pattern.test(relPosixPath)) return true;
      } else if (typeof pattern === "string") {
        if (relPosixPath === pattern || relPosixPath.startsWith(pattern + "/") || baseName === pattern) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Walks repoRoot and builds a sorted workspace manifest.
 *
 * @param {string} repoRoot
 * @param {{ cacheFilePath?: string, excludePatterns?: Array<string | RegExp> }} [options]
 * @returns {{ ok: true, manifest: Array<object>, cache_hits: number, duration_ms: number } | { ok: false, reason: string }}
 */
export function buildWorkspaceManifest(repoRoot, options = {}) {
  const startTime = performance.now();
  if (!repoRoot || !existsSync(repoRoot)) {
    return { ok: false, reason: "REPO_ROOT_NOT_FOUND" };
  }

  const resolvedRoot = resolve(repoRoot);
  const cacheFile = options.cacheFilePath ?? join(resolvedRoot, ".agents", "state", "dream", "workspace-hash-cache.json");

  let diskCache = {};
  if (cacheFile) {
    try {
      if (existsSync(cacheFile)) {
        const raw = readFileSync(cacheFile, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          diskCache = parsed;
        }
      }
    } catch {
      // Cache corruption falls back to full rehash, never fails snapshot
      diskCache = {};
    }
  }

  const nextCache = {};
  let cache_hits = 0;
  const manifest = [];

  // Recursive walk
  function walk(currentDir) {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      return { ok: false, reason: `READDIR_FAILED: ${err.message}` };
    }

    // Sort directory entries deterministically
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPosix = relative(resolvedRoot, fullPath).split(sep).join("/");

      if (isExcluded(relPosix, entry.name, options.excludePatterns)) {
        continue;
      }

      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch (err) {
        return { ok: false, reason: `LSTAT_FAILED: ${err.message}` };
      }

      if (stat.isSymbolicLink()) {
        let rawTarget;
        try {
          rawTarget = readlinkSync(fullPath);
        } catch (err) {
          return { ok: false, reason: `READLINK_FAILED: ${err.message}` };
        }

        const lexicalTarget = isAbsolute(rawTarget)
          ? resolve(rawTarget)
          : resolve(currentDir, rawTarget);
        const lexicalRel = relative(resolvedRoot, lexicalTarget);

        if (lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
          return { ok: false, reason: "EXTERNAL_SYMLINK_UNSAFE" };
        }

        try {
          const real = realpathSync(lexicalTarget);
          const realRel = relative(resolvedRoot, real);
          if (realRel.startsWith("..") || isAbsolute(realRel)) {
            return { ok: false, reason: "EXTERNAL_SYMLINK_UNSAFE" };
          }
        } catch {
          // Dangling internal symlinks are acceptable, verified lexically above
        }

        const normalizedTarget = isAbsolute(rawTarget)
          ? relative(currentDir, rawTarget).split(sep).join("/")
          : rawTarget.split(sep).join("/");

        manifest.push({
          path: relPosix,
          type: "symlink",
          executable: false,
          size: stat.size,
          content_hash: `symlink:${normalizedTarget}`,
        });
      } else if (stat.isDirectory()) {
        const subRes = walk(fullPath);
        if (!subRes.ok) {
          return subRes;
        }
      } else if (stat.isFile()) {
        const cached = diskCache[relPosix];
        let content_hash;
        if (
          cached &&
          cached.size === stat.size &&
          cached.mtimeMs === stat.mtimeMs &&
          typeof cached.content_hash === "string"
        ) {
          content_hash = cached.content_hash;
          cache_hits++;
        } else {
          try {
            content_hash = hashFileSync(fullPath);
          } catch (err) {
            return { ok: false, reason: `HASH_FAILED: ${err.message}` };
          }
        }

        nextCache[relPosix] = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          content_hash,
        };

        const executable = Boolean(stat.mode & 0o111);
        manifest.push({
          path: relPosix,
          type: "file",
          executable,
          size: stat.size,
          content_hash,
        });
      }
    }
    return { ok: true };
  }

  const walkResult = walk(resolvedRoot);
  if (!walkResult.ok) {
    return walkResult;
  }

  // Sort manifest entries lexicographically by relative POSIX path
  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Update metadata cache file safely (never fail snapshot on cache write failure)
  if (cacheFile) {
    try {
      const dir = dirname(cacheFile);
      mkdirSync(dir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(nextCache, null, 2), "utf8");
    } catch {
      // Best-effort cache write
    }
  }

  const duration_ms = performance.now() - startTime;
  return {
    ok: true,
    manifest,
    cache_hits,
    duration_ms,
  };
}

/**
 * Builds task fingerprint.
 *
 * @param {object | string} task
 * @returns {string} Formatted as "sha256:<64-char-hex>"
 */
export function buildTaskFingerprint(task) {
  if (typeof task === "string") {
    task = { spec: task };
  }
  if (!task || typeof task !== "object") {
    throw new TypeError("task must be a string or non-null object");
  }
  const rawSpec = task.spec ?? task.task_spec ?? task.taskSpec ?? task.description ?? task.prompt ?? "";
  const normalizedSpec = normalizeTaskSpec(rawSpec);
  const spec_hash = sha256Canonical(normalizedSpec);
  const task_action = task.task_action ?? task.taskAction ?? "UNKNOWN";
  const task_domain = task.task_domain ?? task.taskDomain ?? "UNKNOWN";
  const criticality = task.criticality ?? "NORMAL";

  return sha256Canonical({
    criticality,
    spec_hash,
    task_action,
    task_domain,
  });
}

/**
 * Builds contract fingerprint with canonical set sorting.
 *
 * @param {object} contract
 * @returns {string} Formatted as "sha256:<64-char-hex>"
 */
export function buildContractFingerprint(contract) {
  if (!contract || typeof contract !== "object") {
    throw new TypeError("contract must be a non-null object");
  }
  const allowed_paths = contract.allowed_paths ?? contract.allowedPaths ?? [];
  const forbidden_paths = contract.forbidden_paths ?? contract.forbiddenPaths ?? [];
  const do_not_change = contract.do_not_change ?? contract.doNotChange ?? [];
  const criteria = contract.criteria ?? contract.acceptance_criteria ?? contract.acceptanceCriteria ?? [];
  const required_validation = contract.required_validation ?? contract.requiredValidation ?? [];
  const retry_budget = contract.retry_budget ?? contract.retryBudget ?? 0;
  const domain = contract.domain ?? contract.task_domain ?? contract.taskDomain ?? "UNKNOWN";
  const criticality = contract.criticality ?? "NORMAL";

  const setLikeKeys = new Set([
    "allowed_paths",
    "forbidden_paths",
    "do_not_change",
    "criteria",
    "required_validation",
    "allowedPaths",
    "forbiddenPaths",
    "doNotChange",
    "acceptanceCriteria",
    "requiredValidation",
  ]);

  const base = {
    allowed_paths,
    criteria,
    criticality,
    do_not_change,
    domain,
    required_validation,
    retry_budget,
  };

  for (const [k, v] of Object.entries(contract)) {
    if (
      !(k in base) &&
      ![
        "allowedPaths",
        "forbiddenPaths",
        "doNotChange",
        "acceptanceCriteria",
        "requiredValidation",
        "retryBudget",
        "taskDomain",
      ].includes(k)
    ) {
      base[k] = v;
    }
  }

  return sha256Canonical(base, { setLikeKeys });
}

/**
 * Builds runtime fingerprint, excluding active exploration policies.
 *
 * @param {object} runtime
 * @returns {string} Formatted as "sha256:<64-char-hex>"
 */
export function buildRuntimeFingerprint(runtime = {}) {
  if (typeof runtime !== "object" || runtime === null) {
    throw new TypeError("runtime must be an object");
  }
  const {
    active_policy: _ap1,
    activePolicy: _ap2,
    active_exploration_policy: _ap3,
    activeExplorationPolicy: _ap4,
    policy: _ap5,
    policy_id: _ap6,
    policyId: _ap7,
    ...rest
  } = runtime;

  const base = {
    agent_profiles: rest.agent_profiles ?? rest.agentProfiles ?? {},
    arch: rest.arch ?? process.arch,
    hooks_version: rest.hooks_version ?? rest.hooks ?? "1.0.0",
    node_version: rest.node_version ?? rest.node ?? process.version,
    platform: rest.platform ?? rest.os ?? process.platform,
    schema_version: rest.schema_version ?? rest.schema ?? DREAM_SCHEMAS.SNAPSHOT,
    state_machine_version: rest.state_machine_version ?? rest.stateMachine ?? "1.0.0",
    toolchain: rest.toolchain ?? {},
  };

  for (const [k, v] of Object.entries(rest)) {
    if (
      !(k in base) &&
      !["agentProfiles", "hooks", "node", "os", "schema", "stateMachine"].includes(k)
    ) {
      base[k] = v;
    }
  }

  return sha256Canonical(base);
}

/**
 * Builds environment fingerprint storing only sha256 hashes of allowlisted variables.
 * Secret values are never stored in cleartext.
 *
 * @param {Record<string, unknown>} [env]
 * @param {Array<string> | Set<string>} [allowlist]
 * @returns {Record<string, string>}
 */
export function buildEnvironmentFingerprint(env = process.env, allowlist = DEFAULT_ENV_ALLOWLIST) {
  if (!env || typeof env !== "object") {
    return {};
  }
  const allowedKeys = Array.isArray(allowlist) || allowlist instanceof Set
    ? [...allowlist]
    : DEFAULT_ENV_ALLOWLIST;

  const result = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined && env[key] !== null) {
      result[key] = sha256Canonical(String(env[key]));
    }
  }
  return result;
}

/**
 * Builds execution state identity.
 *
 * @param {object | string} executionState
 * @returns {string} Formatted as "sha256:<64-char-hex>"
 */
export function buildExecutionStateIdentity(executionState = {}) {
  if (typeof executionState === "string" && executionState.startsWith("sha256:")) {
    return executionState;
  }
  if (!executionState || typeof executionState !== "object") {
    throw new TypeError("executionState must be an object or sha256 string");
  }
  const step_sequence = executionState.step_sequence ?? executionState.step ?? executionState.step_seq ?? 0;
  const attempt = executionState.attempt ?? 0;
  const retry_remaining = executionState.retry_remaining ?? executionState.retryRemaining ?? 0;
  const mutation_seq = executionState.mutation_seq ?? executionState.mutationSeq ?? 0;

  const base = {
    attempt,
    mutation_seq,
    retry_remaining,
    step_sequence,
  };

  for (const [k, v] of Object.entries(executionState)) {
    if (!(k in base) && !["step", "step_seq", "retryRemaining", "mutationSeq"].includes(k)) {
      base[k] = v;
    }
  }

  return sha256Canonical(base);
}

/**
 * Builds evidence fingerprint.
 *
 * @param {object | string} evidence
 * @returns {string} Formatted as "sha256:<64-char-hex>"
 */
export function buildEvidenceFingerprint(evidence = {}) {
  if (typeof evidence === "string" && evidence.startsWith("sha256:")) {
    return evidence;
  }
  if (!evidence || typeof evidence !== "object") {
    throw new TypeError("evidence must be an object or sha256 string");
  }
  const tests = evidence.tests ?? "UNKNOWN";
  const typecheck = evidence.typecheck ?? "UNKNOWN";
  const build = evidence.build ?? "UNKNOWN";
  const validation_fresh = evidence.validation_fresh ?? evidence.validationFresh ?? false;
  const scope_check = evidence.scope_check ?? evidence.scopeCheck ?? "UNKNOWN";
  const ledger_hashes = evidence.ledger_hashes ?? evidence.ledgerHashes ?? evidence.hashes ?? [];

  const base = {
    build,
    ledger_hashes,
    scope_check,
    tests,
    typecheck,
    validation_fresh,
  };

  for (const [k, v] of Object.entries(evidence)) {
    if (
      !(k in base) &&
      !["validationFresh", "scopeCheck", "ledgerHashes", "hashes"].includes(k)
    ) {
      base[k] = v;
    }
  }

  return sha256Canonical(base, { setLikeKeys: new Set(["ledger_hashes", "ledgerHashes"]) });
}

/**
 * Builds a deterministic snapshot record.
 *
 * @param {object} input
 * @param {string} input.repoRoot
 * @param {object | string} input.task
 * @param {object | string} input.contract
 * @param {object | string} input.runtime
 * @param {object | string} [input.environment]
 * @param {object | string} input.executionState
 * @param {object | string} input.evidence
 * @param {object} [input.options]
 * @param {object} [secondOptions]
 * @returns {{ ok: true, snapshot: object } | { ok: false, reason: string }}
 */
export function buildSnapshot(input = {}, secondOptions = {}) {
  const {
    repoRoot,
    task,
    contract,
    runtime,
    environment,
    executionState,
    evidence,
    options: innerOptions,
  } = input;
  const options = innerOptions ?? secondOptions ?? {};

  if (!repoRoot || typeof repoRoot !== "string") {
    return { ok: false, reason: "MISSING_REPO_ROOT" };
  }
  if (!task) {
    return { ok: false, reason: "MISSING_TASK" };
  }
  if (!contract) {
    return { ok: false, reason: "MISSING_CONTRACT" };
  }
  if (!runtime) {
    return { ok: false, reason: "MISSING_RUNTIME" };
  }
  if (!executionState) {
    return { ok: false, reason: "MISSING_EXECUTION_STATE" };
  }
  if (!evidence) {
    return { ok: false, reason: "MISSING_EVIDENCE" };
  }

  const manifestResult = buildWorkspaceManifest(repoRoot, options);
  if (!manifestResult.ok) {
    return { ok: false, reason: manifestResult.reason };
  }

  const workspace_manifest = manifestResult.manifest;
  const workspace_fingerprint = sha256Canonical(workspace_manifest);

  try {
    const task_fingerprint =
      typeof task === "string" && task.startsWith("sha256:")
        ? task
        : buildTaskFingerprint(task);

    const contract_fingerprint =
      typeof contract === "string" && contract.startsWith("sha256:")
        ? contract
        : buildContractFingerprint(contract);

    const runtime_fingerprint =
      typeof runtime === "string" && runtime.startsWith("sha256:")
        ? runtime
        : buildRuntimeFingerprint(runtime);

    const environment_fingerprint =
      typeof environment === "string" && environment.startsWith("sha256:")
        ? environment
        : buildEnvironmentFingerprint(environment ?? process.env, options?.envAllowlist);

    const execution_state_identity =
      typeof executionState === "string" && executionState.startsWith("sha256:")
        ? executionState
        : buildExecutionStateIdentity(executionState);

    const evidence_fingerprint =
      typeof evidence === "string" && evidence.startsWith("sha256:")
        ? evidence
        : buildEvidenceFingerprint(evidence);

    const identityBase = {
      contract_fingerprint,
      environment_fingerprint,
      evidence_fingerprint,
      execution_state_identity,
      runtime_fingerprint,
      schema: DREAM_SCHEMAS.SNAPSHOT,
      task_fingerprint,
      workspace_fingerprint,
    };

    const snapshot_id = sha256Canonical(identityBase);

    const snapshot = {
      schema: DREAM_SCHEMAS.SNAPSHOT,
      snapshot_id,
      task_fingerprint,
      contract_fingerprint,
      runtime_fingerprint,
      workspace_fingerprint,
      environment_fingerprint,
      execution_state_identity,
      evidence_fingerprint,
    };

    if (options?.includeSummary || options?.includeManifestSummary) {
      snapshot.workspace_manifest_summary = {
        file_count: workspace_manifest.length,
        total_bytes: workspace_manifest.reduce((acc, e) => acc + (e.size || 0), 0),
      };
    }

    const validation = validateDreamRecord(DREAM_SCHEMAS.SNAPSHOT, snapshot);
    if (!validation.valid) {
      return { ok: false, reason: validation.errors.join("; ") };
    }

    return { ok: true, snapshot };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
