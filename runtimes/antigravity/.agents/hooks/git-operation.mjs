import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";

function getWorkspacePaths(cwdOverride, customStatePath) {
  const cwd = cwdOverride || process.cwd();

  // Git is the authoritative workspace boundary for git-operation. This avoids
  // resolving nested invocation directories as independent repositories and
  // guarantees that transaction state always lives under the actual repo root.
  const gitRootRes = runGit(["rev-parse", "--show-toplevel"], { cwd });
  let repoRoot;
  if (gitRootRes.status === 0 && gitRootRes.stdout) {
    repoRoot = resolve(gitRootRes.stdout);
  } else if (existsSync(resolve(cwd, "packages"))) {
    repoRoot = cwd;
  } else if (existsSync(resolve(cwd, "../packages"))) {
    repoRoot = resolve(cwd, "..");
  } else {
    repoRoot = cwd;
  }

  const statePath = customStatePath
    ? resolve(cwd, customStatePath)
    : resolve(repoRoot, ".agents/state/active-state.json");

  return {
    repoRoot,
    statePath,
    telemetryPath: resolve(repoRoot, ".agents/telemetry/events.jsonl"),
  };
}

function runGit(args = [], options = {}) {
  const cwd = options.cwd || process.cwd();
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeout || 30000,
    });
    return { status: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: (err.stdout || "").toString().trim(),
      stderr: (err.stderr || "").toString().trim() || err.message,
    };
  }
}

export function parseGitStatus(porcelainOutput = "") {
  const lines = porcelainOutput.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const allDirty = [];

  for (const line of lines) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    const pathPart = line.slice(3).trim();
    // Handle rename "orig -> dest"
    const filePath = pathPart.includes(" -> ") ? pathPart.split(" -> ")[1] : pathPart;

    allDirty.push(filePath);

    if (x === "?" && y === "?") {
      untracked.push(filePath);
    } else {
      if (x !== " " && x !== "?") {
        staged.push({ path: filePath, code: x });
      }
      if (y !== " " && y !== "?") {
        unstaged.push({ path: filePath, code: y });
      }
    }
  }

  return {
    lines,
    staged,
    unstaged,
    untracked,
    allDirty,
    isClean: lines.length === 0,
  };
}

function isDangerousOrSecretPath(filePath) {
  const norm = String(filePath || "").toLowerCase();
  return (
    norm.includes("secret") ||
    norm.includes(".env") ||
    norm.includes("credential") ||
    norm.endsWith(".pem") ||
    norm.endsWith(".key") ||
    norm.endsWith(".p12") ||
    norm.includes("id_rsa") ||
    norm.includes("token")
  );
}

export function executeGitOperation(options = {}) {
  const cwd = options.cwd || process.cwd();
  const { repoRoot, statePath } = getWorkspacePaths(options.cwd, options.statePath);
  const gitCwd = repoRoot;
  const action = (options.action || "commit_push").toLowerCase();
  const expectedFiles = Array.isArray(options.files)
    ? options.files.map((f) => String(f).replace(/\\/g, "/").replace(/^\.\//, ""))
    : (options.files ? [String(options.files).replace(/\\/g, "/").replace(/^\.\//, "")] : null);
  const message = options.message || options.commitMessage || null;
  const remote = options.remote || "origin";
  let branch = options.branch || null;
  const dryRun = options.dryRun === true;

  // Load active state if exists for idempotency check
  let activeState = {};
  if (existsSync(statePath)) {
    try {
      activeState = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {}
  }

  // Determine current branch if not provided
  if (!branch) {
    const branchRes = runGit(["branch", "--show-current"], { cwd: gitCwd });
    if (branchRes.status === 0 && branchRes.stdout) {
      branch = branchRes.stdout;
    } else {
      const revRes = runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: gitCwd });
      branch = revRes.status === 0 ? revRes.stdout : "unknown";
    }
  }

  // 1. STATUS
  if (action === "status") {
    const res = runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: gitCwd });
    const parsed = parseGitStatus(res.stdout);
    const compactOutput = [
      "GIT_OPERATION_SUCCESS",
      `action: status`,
      `branch: ${branch}`,
      `clean: ${parsed.isClean}`,
      `staged: ${parsed.staged.length}`,
      `unstaged: ${parsed.unstaged.length}`,
      `untracked: ${parsed.untracked.length}`,
      parsed.allDirty.length > 0 ? `files: ${parsed.allDirty.slice(0, 10).join(", ")}${parsed.allDirty.length > 10 ? ` (+${parsed.allDirty.length - 10} more)` : ""}` : "files: none",
    ].join("\n");

    return {
      success: true,
      action: "status",
      branch,
      parsed,
      output: compactOutput,
    };
  }

  // 2. DIFF_SUMMARY
  if (action === "diff_summary") {
    const statRes = runGit(["diff", "--stat"], { cwd: gitCwd });
    const stagedStatRes = runGit(["diff", "--cached", "--stat"], { cwd: gitCwd });
    const summaryLines = [
      "GIT_OPERATION_SUCCESS",
      `action: diff_summary`,
      `branch: ${branch}`,
      "unstaged:",
      statRes.stdout || "  (no unstaged changes)",
      "staged:",
      stagedStatRes.stdout || "  (no staged changes)",
    ];

    return {
      success: true,
      action: "diff_summary",
      branch,
      output: summaryLines.join("\n"),
    };
  }

  // 3. COMMIT or COMMIT_PUSH
  if (action === "commit" || action === "commit_push") {
    // Check compact git status first
    const statusRes = runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: gitCwd });
    const parsedStatus = parseGitStatus(statusRes.stdout);

    // Idempotency check: if transaction already committed and clean, or commitCreated: true
    const currentHeadCommitRes = runGit(["rev-parse", "HEAD"], { cwd: gitCwd });
    const currentHeadHash = currentHeadCommitRes.status === 0 ? currentHeadCommitRes.stdout : null;
    const lastHeadMsgRes = runGit(["log", "-1", "--pretty=%B"], { cwd: gitCwd });
    const lastHeadMsg = lastHeadMsgRes.status === 0 ? lastHeadMsgRes.stdout.trim() : "";
    const requestedMessage = message && message.trim()
      ? message.trim()
      : (activeState.changeSummary || "chore: automated direct action commit");
    const normalizedExpectedFiles = expectedFiles
      ? [...new Set(expectedFiles)].sort()
      : null;
    const transactionStateRel = String(relative(repoRoot, statePath)).replace(/\\/g, "/");
    const isTransactionStateOnlyDirty = parsedStatus.allDirty.length > 0
      && parsedStatus.allDirty.every((p) => p === transactionStateRel);
    const idempotencyTreeClean = parsedStatus.isClean || isTransactionStateOnlyDirty;

    let commitAlreadyCreated = false;
    let existingCommitHash = null;

    const tx = activeState.gitTransaction;
    if (tx && tx.commitCreated && tx.commitHash) {
      const txFiles = Array.isArray(tx.files) ? [...new Set(tx.files)].sort() : null;
      const sameFiles = JSON.stringify(txFiles) === JSON.stringify(normalizedExpectedFiles);
      const sameHead = Boolean(
        currentHeadHash &&
        (currentHeadHash === tx.commitHash ||
          currentHeadHash.startsWith(tx.commitHash) ||
          String(tx.commitHash).startsWith(currentHeadHash))
      );
      const sameIntent =
        tx.action === action &&
        tx.branch === branch &&
        tx.remote === remote &&
        tx.message === requestedMessage &&
        sameFiles;

      // A prior transaction is reusable only when it is exactly the operation
      // being retried and the repository has not changed since that commit.
      if (sameIntent && sameHead && idempotencyTreeClean) {
        commitAlreadyCreated = true;
        existingCommitHash = currentHeadHash;
      }
    }

    // Crash recovery when control-plane transaction state was lost after commit:
    // exact message + clean tree is enough to reuse the current HEAD, but prefix
    // matches are intentionally rejected.
    if (!commitAlreadyCreated && lastHeadMsg === requestedMessage && idempotencyTreeClean) {
      commitAlreadyCreated = true;
      existingCommitHash = currentHeadHash;
    }

    let stagedCount = 0;
    let commitHash = existingCommitHash;

    if (!commitAlreadyCreated) {
      // Step 2: Validate allowed files & scope
      if (expectedFiles && expectedFiles.length > 0) {
        const isExpectedPath = (path) =>
          expectedFiles.includes(path) || expectedFiles.some((ef) => path.startsWith(ef + "/"));

        // Pre-existing staged files are part of the next commit regardless of what
        // we stage now. If any staged path is outside the explicit allowlist, fail
        // closed rather than silently committing unrelated work.
        const unexpectedStaged = parsedStatus.staged
          .map((entry) => entry.path)
          .filter((path) => !isExpectedPath(path));
        if (unexpectedStaged.length > 0) {
          return {
            success: false,
            blocked: true,
            action,
            reason: "unexpected_staged_paths",
            unexpectedFiles: unexpectedStaged,
            output: [
              "DIRECT_ACTION_BLOCKED",
              "reason: pre-existing staged paths detected outside explicit commit scope",
              `unexpected_files: [${unexpectedStaged.join(", ")}]`,
              "recommended next action: Unstage unrelated paths or include them explicitly.",
            ].join("\n"),
          };
        }

        // Verify if any unexpected dirty files exist
        const unexpected = parsedStatus.allDirty.filter((path) => !isExpectedPath(path));

        // If dangerous files or secrets are present among unexpected files, block immediately
        const dangerousUnexpected = unexpected.filter(isDangerousOrSecretPath);
        if (dangerousUnexpected.length > 0 || (options.strictScope && unexpected.length > 0)) {
          const blockedOutput = [
            "DIRECT_ACTION_BLOCKED",
            "reason: unexpected dirty paths detected outside allowed scope",
            `unexpected_files: [${(dangerousUnexpected.length > 0 ? dangerousUnexpected : unexpected).join(", ")}]`,
            "recommended next action: Inspect repository state and remove or specify unexpected files explicitly.",
          ].join("\n");

          return {
            success: false,
            blocked: true,
            action,
            reason: "unexpected_dirty_paths",
            unexpectedFiles: unexpected,
            output: blockedOutput,
          };
        }

        // Stage ONLY the intended files
        for (const file of expectedFiles) {
          if (parsedStatus.allDirty.includes(file) || existsSync(resolve(repoRoot, file))) {
            const addRes = runGit(["add", file], { cwd: gitCwd });
            if (addRes.status !== 0) {
              return {
                success: false,
                blocked: true,
                action,
                reason: `git add failed for "${file}": ${addRes.stderr}`,
                output: `DIRECT_ACTION_BLOCKED\nreason: git add failed for "${file}"\nrelevant excerpt: ${addRes.stderr}`,
              };
            }
          }
        }
        stagedCount = expectedFiles.length;
      } else {
        // No explicit files list given: check if already staged or if worktree contains dangerous unexpected files
        const dangerous = parsedStatus.allDirty.filter(isDangerousOrSecretPath);
        if (dangerous.length > 0) {
          return {
            success: false,
            blocked: true,
            action,
            reason: "dangerous_dirty_paths_detected",
            unexpectedFiles: dangerous,
            output: [
              "DIRECT_ACTION_BLOCKED",
              "reason: potentially sensitive or unexpected files detected in dirty state",
              `files: [${dangerous.join(", ")}]`,
              "recommended next action: Explicitly specify target files or stage intended files manually.",
            ].join("\n"),
          };
        }

        if (parsedStatus.staged.length === 0 && parsedStatus.unstaged.length > 0) {
          // If files were not staged yet, stage unstaged (excluding untracked to be safe)
          for (const u of parsedStatus.unstaged) {
            runGit(["add", u.path], { cwd: gitCwd });
          }
        }
        stagedCount = parsedStatus.staged.length + parsedStatus.unstaged.length;
      }

      // Check if anything is staged for commit
      const postStageStatusRes = runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: gitCwd });
      const postStageParsed = parseGitStatus(postStageStatusRes.stdout);
      if (postStageParsed.staged.length === 0) {
        return {
          success: false,
          blocked: true,
          action,
          reason: "nothing_to_commit",
          output: "DIRECT_ACTION_BLOCKED\nreason: nothing staged to commit\nrecommended next action: Verify working tree changes before committing.",
        };
      }

      // Determine commit message
      const finalMessage = requestedMessage;

      // Execute commit
      const commitRes = runGit(["commit", "-m", finalMessage], { cwd: gitCwd });
      if (commitRes.status !== 0) {
        // Handle pre-commit hook failure or other commit failure
        const hookExcerpt = (commitRes.stderr || commitRes.stdout || "").split("\n").slice(0, 8).join("\n");
        return {
          success: false,
          blocked: true,
          action,
          reason: "pre-commit hook failed or commit rejected",
          commitCreated: false,
          output: [
            "DIRECT_ACTION_BLOCKED",
            "reason: pre-commit hook failed or commit rejected",
            "relevant excerpt:",
            hookExcerpt || "  (no error output)",
            "recommended next action: Review hook failures and resolve issues before committing.",
          ].join("\n"),
        };
      }

      // Capture commit hash
      const hashRes = runGit(["rev-parse", "HEAD"], { cwd: gitCwd });
      commitHash = hashRes.status === 0 ? hashRes.stdout : "unknown";

      // Update state idempotency tracking
      activeState.gitTransaction = {
        action,
        commitCreated: true,
        commitHash,
        message: finalMessage,
        files: normalizedExpectedFiles,
        remote,
        branch,
        pushSucceeded: false,
        timestamp: new Date().toISOString(),
      };
      try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
    }

    if (action === "commit") {
      return {
        success: true,
        action: "commit",
        branch,
        commit: commitHash,
        message: message || activeState.gitTransaction?.message || "",
        files: stagedCount,
        output: [
          "GIT_OPERATION_SUCCESS",
          `branch: ${branch}`,
          `commit: ${commitHash}`,
          `message: ${message || activeState.gitTransaction?.message || ""}`,
          `files: ${stagedCount}`,
        ].join("\n"),
      };
    }

    // Step 5: PUSH for commit_push
    const pushArgs = ["push"];
    if (dryRun) pushArgs.push("--dry-run");
    if (remote) pushArgs.push(remote);
    if (branch && branch !== "unknown") {
      const curBranchRes = runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: gitCwd });
      const currentLocalBranch = curBranchRes.status === 0 ? curBranchRes.stdout : null;
      if (currentLocalBranch && currentLocalBranch !== branch && currentLocalBranch !== "HEAD") {
        pushArgs.push(`${currentLocalBranch}:${branch}`);
      } else {
        pushArgs.push(branch);
      }
    }

    const pushRes = runGit(pushArgs, { cwd: gitCwd });
    if (pushRes.status !== 0) {
      // Partial failure: commit succeeded, push failed
      if (activeState.gitTransaction) {
        activeState.gitTransaction.pushSucceeded = false;
        try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
      }

      const pushErrExcerpt = (pushRes.stderr || pushRes.stdout || "").split("\n").slice(0, 6).join("\n");
      return {
        success: false,
        partialFailure: true,
        blocked: true,
        action: "commit_push",
        commitCreated: true,
        pushSucceeded: false,
        commit: commitHash,
        remote,
        branch,
        output: [
          "DIRECT_ACTION_BLOCKED",
          "reason: commit succeeded but push failed (partial failure)",
          `commit: ${commitHash}`,
          `remote: ${remote}`,
          `branch: ${branch}`,
          "relevant excerpt:",
          pushErrExcerpt || "  (no error output)",
          "recommended next action: Retry push only without recreating commit.",
        ].join("\n"),
      };
    }

    // Push succeeded
    if (activeState.gitTransaction) {
      activeState.gitTransaction.pushSucceeded = true;
      try { writeFileSync(statePath, JSON.stringify(activeState, null, 2), "utf-8"); } catch {}
    }

    return {
      success: true,
      action: "commit_push",
      branch,
      commit: commitHash,
      commitCreated: true,
      pushSucceeded: true,
      message: message || activeState.gitTransaction?.message || "",
      files: stagedCount,
      push: "success",
      output: [
        "GIT_OPERATION_SUCCESS",
        `branch: ${branch}`,
        `commit: ${commitHash}`,
        `message: ${message || activeState.gitTransaction?.message || ""}`,
        `files: ${stagedCount}`,
        "push: success",
      ].join("\n"),
    };
  }

  // 4. PUSH only
  if (action === "push") {
    const pushArgs = ["push"];
    if (dryRun) pushArgs.push("--dry-run");
    if (remote) pushArgs.push(remote);
    if (branch && branch !== "unknown") {
      const curBranchRes = runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: gitCwd });
      const currentLocalBranch = curBranchRes.status === 0 ? curBranchRes.stdout : null;
      if (currentLocalBranch && currentLocalBranch !== branch && currentLocalBranch !== "HEAD") {
        pushArgs.push(`${currentLocalBranch}:${branch}`);
      } else {
        pushArgs.push(branch);
      }
    }

    const pushRes = runGit(pushArgs, { cwd: gitCwd });
    if (pushRes.status !== 0) {
      const pushErrExcerpt = (pushRes.stderr || pushRes.stdout || "").split("\n").slice(0, 6).join("\n");
      return {
        success: false,
        blocked: true,
        action: "push",
        pushSucceeded: false,
        remote,
        branch,
        output: [
          "DIRECT_ACTION_BLOCKED",
          "reason: git push failed",
          `remote: ${remote}`,
          `branch: ${branch}`,
          "relevant excerpt:",
          pushErrExcerpt || "  (no error output)",
        ].join("\n"),
      };
    }

    return {
      success: true,
      action: "push",
      remote,
      branch,
      push: "success",
      output: [
        "GIT_OPERATION_SUCCESS",
        `action: push`,
        `branch: ${branch}`,
        `remote: ${remote}`,
        "push: success",
      ].join("\n"),
    };
  }

  return {
    success: false,
    blocked: true,
    action,
    reason: `Unknown action "${action}"`,
    output: `DIRECT_ACTION_BLOCKED\nreason: unsupported git action "${action}"`,
  };
}

function parseCliArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--action" && args[i + 1]) {
      options.action = args[++i];
    } else if (arg === "--message" && args[i + 1]) {
      options.message = args[++i];
    } else if (arg === "--remote" && args[i + 1]) {
      options.remote = args[++i];
    } else if (arg === "--branch" && args[i + 1]) {
      options.branch = args[++i];
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--strict-scope") {
      options.strictScope = true;
    } else if (arg === "--files" && args[i + 1]) {
      options.files = [];
      while (args[i + 1] && !args[i + 1].startsWith("--")) {
        options.files.push(args[++i]);
      }
    } else if (arg === "--json" && args[i + 1]) {
      try {
        const parsed = JSON.parse(args[++i]);
        Object.assign(options, parsed);
      } catch {}
    }
  }
  return options;
}

function main() {
  const cliArgs = process.argv.slice(2);
  let options = parseCliArgs(cliArgs);

  if (Object.keys(options).length === 0) {
    try {
      const stdin = readFileSync(0, "utf-8");
      if (stdin.trim()) {
        options = JSON.parse(stdin);
      }
    } catch {}
  }

  const result = executeGitOperation(options);
  console.log(result.output);
  if (!result.success) {
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("git-operation.mjs")) {
  main();
}
