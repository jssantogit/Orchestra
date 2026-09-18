import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  finalizeEvidenceRecord,
  normalizeEvidenceRequirements,
} from "./evidence-contract.mjs";

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function git(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      stdout: String(result.stdout || "").trim(),
      stderr: String(result.stderr || result.error?.message || "").trim(),
    };
  }
  return {
    ok: true,
    status: 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

export function parseGitHubRepository(remoteUrl) {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return null;
  let match = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!match) match = raw.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!match) match = raw.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!match) return null;
  return match[1] + "/" + match[2].replace(/\.git$/i, "");
}

export function readFactualGitIdentity(repoRoot) {
  const origin = git(repoRoot, ["config", "--get", "remote.origin.url"]);
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);

  if (!origin.ok || !head.ok || !branch.ok || !dirty.ok) {
    return {
      ok: false,
      reason: "GIT_IDENTITY_UNAVAILABLE",
      details: { origin, head, branch, dirty },
    };
  }

  const repository = parseGitHubRepository(origin.stdout);
  if (!repository) {
    return {
      ok: false,
      reason: "ORIGIN_NOT_GITHUB_REPOSITORY",
      origin: origin.stdout,
    };
  }

  return {
    ok: true,
    repository,
    originUrl: origin.stdout,
    headSha: head.stdout,
    branch: branch.stdout === "HEAD" ? null : branch.stdout,
    trackedDirty: dirty.stdout.length > 0,
    trackedStatus: dirty.stdout,
  };
}

function binding(activeState, factual) {
  return {
    taskId: activeState.taskId || activeState.taskKey || null,
    attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
    commitSha: factual?.headSha || null,
    branch: factual?.branch || null,
    mutationSeq: typeof activeState.mutationSeq === "number"
      ? activeState.mutationSeq
      : typeof activeState.mutation_seq === "number"
        ? activeState.mutation_seq
        : 0,
  };
}

function evidenceId(requirement, bindingValue, suffix) {
  return "evidence-" + digest(JSON.stringify({
    requirementId: requirement.id,
    class: requirement.class,
    kind: requirement.kind,
    binding: bindingValue,
    suffix: suffix || null,
  }));
}

function runtimeRecord({
  requirement,
  result,
  reason = null,
  activeState,
  factual,
  provider = null,
  details = {},
  source,
  suffix = null,
}) {
  const bound = binding(activeState, factual);
  return finalizeEvidenceRecord({
    evidenceId: evidenceId(requirement, bound, suffix || result),
    requirementId: requirement.id,
    class: requirement.class,
    kind: requirement.kind,
    result,
    reason,
    provider,
    ...details,
    binding: bound,
    provenance: {
      source,
      observedAt: new Date().toISOString(),
    },
  });
}

function checkIgnored(repoRoot, paths) {
  for (const path of paths) {
    const result = git(repoRoot, ["check-ignore", "-q", "--", path]);
    if (!result.ok) return false;
  }
  return true;
}

export function collectLocalFactRequirement({ repoRoot, activeState = {}, requirement, factualGit = null }) {
  const factual = factualGit || readFactualGitIdentity(repoRoot);
  if (!factual.ok) {
    return runtimeRecord({
      requirement,
      result: "UNAVAILABLE",
      reason: factual.reason,
      activeState,
      factual: null,
      source: "ORCHESTRA_LOCAL_FACT_COLLECTOR",
      details: { collectorDetails: factual.details || null },
    });
  }

  const cls = String(requirement.class || "").toUpperCase();
  let pass = false;
  let reason = null;
  let fact = {};

  if (cls === "FILE_EXISTS") {
    const path = String(requirement.path || "");
    if (!path) {
      pass = false;
      reason = "FILE_PATH_REQUIRED";
    } else {
      pass = existsSync(resolve(repoRoot, path));
      reason = pass ? null : "FILE_NOT_FOUND";
      fact = { path };
    }
  } else if (cls === "FILE_NOT_EXISTS") {
    const path = String(requirement.path || "");
    if (!path) {
      pass = false;
      reason = "FILE_PATH_REQUIRED";
    } else {
      pass = !existsSync(resolve(repoRoot, path));
      reason = pass ? null : "FILE_EXISTS_UNEXPECTEDLY";
      fact = { path };
    }
  } else if (cls === "EXPECTED_FILE_MODIFIED") {
    const path = String(requirement.path || "");
    const status = path ? git(repoRoot, ["status", "--porcelain", "--", path]) : { ok: false };
    pass = Boolean(path && status.ok && status.stdout);
    reason = pass ? null : "EXPECTED_FILE_NOT_MODIFIED";
    fact = { path, status: status.stdout || "" };
  } else if (cls === "GIT_CLEAN") {
    pass = factual.trackedDirty === false;
    reason = pass ? null : "TRACKED_WORKTREE_DIRTY";
    fact = { trackedStatus: factual.trackedStatus };
  } else if (cls === "GIT_IGNORED") {
    const paths = Array.isArray(requirement.paths)
      ? requirement.paths.map(String)
      : requirement.path
        ? [String(requirement.path)]
        : [];
    pass = paths.length > 0 && checkIgnored(repoRoot, paths);
    reason = pass ? null : (paths.length === 0 ? "GIT_IGNORE_PATH_REQUIRED" : "PATH_NOT_IGNORED");
    fact = { paths };
  } else if (cls === "HEAD_SHA") {
    const expected = String(requirement.sha || requirement.expected || factual.headSha);
    pass = factual.headSha === expected;
    reason = pass ? null : "HEAD_SHA_MISMATCH";
    fact = { expected, observed: factual.headSha };
  } else if (cls === "BRANCH_REF") {
    const expected = String(requirement.ref || requirement.branch || "");
    pass = Boolean(expected && factual.branch === expected);
    reason = pass ? null : "BRANCH_REF_MISMATCH";
    fact = { expected, observed: factual.branch };
  } else {
    return runtimeRecord({
      requirement,
      result: "UNAVAILABLE",
      reason: "UNSUPPORTED_LOCAL_FACT_CLASS",
      activeState,
      factual,
      source: "ORCHESTRA_LOCAL_FACT_COLLECTOR",
      details: { fact: { class: cls } },
    });
  }

  return runtimeRecord({
    requirement,
    result: pass ? "PASS" : "FAIL",
    reason,
    activeState,
    factual,
    source: "ORCHESTRA_LOCAL_FACT_COLLECTOR",
    details: { fact },
    suffix: JSON.stringify(fact),
  });
}

function resolveToken() {
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (envToken) return envToken;
  const gh = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (!gh.error && gh.status === 0 && String(gh.stdout || "").trim()) {
    return String(gh.stdout).trim();
  }
  return "";
}

async function githubApi(path, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Orchestra-Evidence-Collector",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetch("https://api.github.com" + path, { headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const error = new Error("GitHub API " + response.status);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function workflowMatches(requirement, run) {
  const workflow = requirement.workflow && typeof requirement.workflow === "object"
    ? requirement.workflow
    : {};
  if (workflow.id !== undefined && Number(workflow.id) !== Number(run.workflow_id)) return false;
  if (workflow.path && String(workflow.path) !== String(run.path || "")) return false;
  if (workflow.name && String(workflow.name) !== String(run.name || "")) return false;
  return Boolean(workflow.id !== undefined || workflow.path || workflow.name);
}

function jobsByName(jobs) {
  return new Map((jobs || []).map((job) => [String(job.name), job]));
}

export function validateGitHubActionsPayload({ requirement, run, jobs, factual, activeState = {} }) {
  if (!run) return { result: "PENDING", reason: "CI_RUN_NOT_FOUND_YET" };
  if (String(run.repository?.full_name || factual.repository) !== factual.repository) {
    return { result: "FAIL", reason: "CI_REPOSITORY_MISMATCH" };
  }
  if (String(run.head_sha || "") !== factual.headSha) {
    return { result: "STALE", reason: "CI_COMMIT_MISMATCH" };
  }
  if (!workflowMatches(requirement, run)) {
    return { result: "FAIL", reason: "CI_WORKFLOW_MISMATCH" };
  }
  if (factual.branch && run.head_branch && String(run.head_branch) !== factual.branch) {
    return { result: "STALE", reason: "CI_BRANCH_MISMATCH" };
  }
  const allowedEvents = Array.isArray(requirement.allowedEvents) ? requirement.allowedEvents.map(String) : [];
  if (allowedEvents.length > 0 && !allowedEvents.includes(String(run.event || ""))) {
    return { result: "FAIL", reason: "CI_EVENT_NOT_ALLOWED" };
  }
  if (factual.trackedDirty) {
    return { result: "STALE", reason: "LOCAL_MUTATION_AFTER_VALIDATED_COMMIT" };
  }

  const status = String(run.status || "");
  if (status !== "completed") {
    return { result: "PENDING", reason: "CI_RUN_" + (status || "PENDING").toUpperCase() };
  }

  const requiredJobs = Array.isArray(requirement.requiredJobs)
    ? requirement.requiredJobs.map((item) => typeof item === "string" ? item : String(item?.name || ""))
      .filter(Boolean)
    : [];
  const byName = jobsByName(jobs);
  const missingJobs = requiredJobs.filter((name) => !byName.has(name));
  if (missingJobs.length > 0) {
    return { result: "FAIL", reason: "CI_REQUIRED_JOBS_MISSING", missingJobs };
  }

  const badShaJobs = requiredJobs.filter((name) => {
    const job = byName.get(name);
    return job?.head_sha && String(job.head_sha) !== factual.headSha;
  });
  if (badShaJobs.length > 0) {
    return { result: "STALE", reason: "CI_JOB_COMMIT_MISMATCH", badShaJobs };
  }

  const incompleteJobs = requiredJobs.filter((name) => String(byName.get(name)?.status || "") !== "completed");
  if (incompleteJobs.length > 0) {
    return { result: "PENDING", reason: "CI_REQUIRED_JOBS_PENDING", pendingJobs: incompleteJobs };
  }

  const failedJobs = requiredJobs.filter((name) => String(byName.get(name)?.conclusion || "") !== "success");
  if (failedJobs.length > 0) {
    return { result: "FAIL", reason: "CI_REQUIRED_JOB_FAILED", failedJobs };
  }

  if (String(run.conclusion || "") !== "success") {
    return { result: "FAIL", reason: "CI_RUN_FAILED", conclusion: run.conclusion || null };
  }

  return { result: "PASS", reason: null };
}

export async function collectGitHubActionsRequirement({ repoRoot, activeState = {}, requirement }) {
  const factual = readFactualGitIdentity(repoRoot);
  if (!factual.ok) {
    return runtimeRecord({
      requirement,
      result: "UNAVAILABLE",
      reason: factual.reason,
      activeState,
      factual: null,
      provider: "GITHUB_ACTIONS",
      source: "ORCHESTRA_GITHUB_COLLECTOR",
    });
  }

  const expectedRepository = requirement.repository && requirement.repository !== "CURRENT_ORIGIN"
    ? String(requirement.repository)
    : factual.repository;
  if (expectedRepository !== factual.repository) {
    return runtimeRecord({
      requirement,
      result: "FAIL",
      reason: "EVIDENCE_REPOSITORY_BINDING_MISMATCH",
      activeState,
      factual,
      provider: "GITHUB_ACTIONS",
      source: "ORCHESTRA_GITHUB_COLLECTOR",
      details: { repository: factual.repository, expectedRepository },
    });
  }

  const token = resolveToken();
  try {
    const query = encodeURIComponent(factual.headSha);
    const runsBody = await githubApi(
      "/repos/" + factual.repository + "/actions/runs?head_sha=" + query + "&per_page=100",
      token,
    );
    const matchingRuns = (runsBody?.workflow_runs || [])
      .filter((run) => workflowMatches(requirement, run))
      .filter((run) => !factual.branch || !run.head_branch || String(run.head_branch) === factual.branch)
      .sort((a, b) => Number(b.run_attempt || 0) - Number(a.run_attempt || 0) || Number(b.id || 0) - Number(a.id || 0));
    const run = matchingRuns[0] || null;

    if (!run) {
      return runtimeRecord({
        requirement,
        result: "PENDING",
        reason: "CI_RUN_NOT_FOUND_YET",
        activeState,
        factual,
        provider: "GITHUB_ACTIONS",
        source: "ORCHESTRA_GITHUB_COLLECTOR",
        details: {
          repository: factual.repository,
          workflow: structuredClone(requirement.workflow || {}),
          run: null,
          jobs: [],
        },
      });
    }

    const jobsBody = await githubApi(
      "/repos/" + factual.repository + "/actions/runs/" + run.id + "/jobs?per_page=100",
      token,
    );
    const jobs = Array.isArray(jobsBody?.jobs) ? jobsBody.jobs : [];
    const verdict = validateGitHubActionsPayload({ requirement, run, jobs, factual, activeState });

    const compactJobs = jobs.map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      headSha: job.head_sha || null,
      startedAt: job.started_at || null,
      completedAt: job.completed_at || null,
    }));

    return runtimeRecord({
      requirement,
      result: verdict.result,
      reason: verdict.reason,
      activeState,
      factual,
      provider: "GITHUB_ACTIONS",
      source: "ORCHESTRA_GITHUB_COLLECTOR",
      suffix: String(run.id) + ":" + String(run.run_attempt || 1) + ":" + verdict.result,
      details: {
        repository: factual.repository,
        workflow: {
          id: run.workflow_id,
          name: run.name || null,
          path: run.path || null,
        },
        run: {
          id: run.id,
          attempt: run.run_attempt || 1,
          event: run.event || null,
          headSha: run.head_sha || null,
          headBranch: run.head_branch || null,
          status: run.status || null,
          conclusion: run.conclusion || null,
        },
        jobs: compactJobs,
        requiredJobs: Array.isArray(requirement.requiredJobs) ? structuredClone(requirement.requiredJobs) : [],
        collectorDetails: verdict,
      },
    });
  } catch (error) {
    return runtimeRecord({
      requirement,
      result: "UNAVAILABLE",
      reason: "GITHUB_API_UNAVAILABLE",
      activeState,
      factual,
      provider: "GITHUB_ACTIONS",
      source: "ORCHESTRA_GITHUB_COLLECTOR",
      details: {
        repository: factual.repository,
        collectorDetails: {
          message: String(error?.message || error),
          status: error?.status || null,
        },
      },
    });
  }
}

function mergeEvidenceRecord(activeState, record) {
  if (!Array.isArray(activeState.evidenceLedger)) activeState.evidenceLedger = [];
  const idx = activeState.evidenceLedger.findIndex((ev) => (
    ev
    && ev.requirementId === record.requirementId
    && ev.kind === record.kind
    && ev.binding?.attempt === record.binding?.attempt
  ));
  if (idx >= 0) activeState.evidenceLedger[idx] = record;
  else activeState.evidenceLedger.push(record);
}

function runRemoteCollectorSync(repoRoot, activeState, requirement) {
  const payload = Buffer.from(JSON.stringify({ repoRoot, activeState, requirement }), "utf8").toString("base64url");
  const selfPath = fileURLToPath(import.meta.url);
  const child = spawnSync(process.execPath, [selfPath, "--github-actions-probe", payload], {
    encoding: "utf8",
    timeout: Number(requirement.timeoutMs || 30000),
    env: process.env,
  });
  if (child.error || child.status !== 0) {
    const factual = readFactualGitIdentity(repoRoot);
    return runtimeRecord({
      requirement,
      result: "UNAVAILABLE",
      reason: child.error?.code === "ETIMEDOUT" ? "GITHUB_COLLECTOR_TIMEOUT" : "GITHUB_COLLECTOR_FAILED",
      activeState,
      factual: factual.ok ? factual : null,
      provider: "GITHUB_ACTIONS",
      source: "ORCHESTRA_GITHUB_COLLECTOR",
      details: { collectorDetails: { stderr: String(child.stderr || child.error?.message || "").slice(0, 1000) } },
    });
  }
  try {
    return JSON.parse(String(child.stdout || "").trim());
  } catch {
    const factual = readFactualGitIdentity(repoRoot);
    return runtimeRecord({
      requirement,
      result: "UNAVAILABLE",
      reason: "GITHUB_COLLECTOR_INVALID_OUTPUT",
      activeState,
      factual: factual.ok ? factual : null,
      provider: "GITHUB_ACTIONS",
      source: "ORCHESTRA_GITHUB_COLLECTOR",
    });
  }
}

export function collectRuntimeEvidenceSync({ repoRoot, activeState = {}, contract = null } = {}) {
  const effectiveContract = contract || activeState.scopeContract || {};
  const normalized = normalizeEvidenceRequirements(effectiveContract, activeState);
  if (!normalized.valid) {
    return { collected: false, reason: normalized.reason, records: [] };
  }

  const factual = readFactualGitIdentity(repoRoot);
  const records = [];
  for (const requirement of normalized.requirements) {
    if (requirement.kind === "LOCAL_FACT") {
      records.push(collectLocalFactRequirement({
        repoRoot,
        activeState,
        requirement,
        factualGit: factual,
      }));
    } else if (
      requirement.kind === "REMOTE_CI"
      && String(requirement.provider || "").toUpperCase() === "GITHUB_ACTIONS"
    ) {
      records.push(runRemoteCollectorSync(repoRoot, activeState, requirement));
    }
  }

  for (const record of records) mergeEvidenceRecord(activeState, record);
  return { collected: true, records };
}

async function cliMain() {
  if (process.argv[2] !== "--github-actions-probe") return false;
  try {
    const decoded = Buffer.from(String(process.argv[3] || ""), "base64url").toString("utf8");
    const input = JSON.parse(decoded);
    const record = await collectGitHubActionsRequirement(input);
    process.stdout.write(JSON.stringify(record));
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(String(error?.stack || error));
    process.exitCode = 2;
  }
  return true;
}

await cliMain();
