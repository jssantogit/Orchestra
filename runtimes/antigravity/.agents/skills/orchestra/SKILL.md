---
name: orchestra
description: >-
  Local multi-agent architecture for multi-agent development using Gemini 3.8 Flash Medium (orchestrator), Gemini 3.8 Flash High/Medium/Low (workers), and Two-Key independent critical review.
---

# Orchestra Antigravity ALL-GEMINI Architecture

Orchestra provides a 100% **ALL-GEMINI** local architecture in the Antigravity CLI.
- **Gemini 3.8 Flash Medium (`gemini-3.8-flash-medium`)**: Global Orchestrator and Control Plane.
- **Gemini 3.8 Flash High (`gemini-3.8-flash-high`)**: Complex Implementation Worker, Investigation Specialist, and Independent Reviewer.
- **Gemini 3.8 Flash Medium (`gemini-3.8-flash-medium`)**: Standard Implementation Worker.
- **Gemini 3.8 Flash Low (`gemini-3.8-flash-low`)**: Docs, mechanical fixes, and simple tests.
- **Two-Key Critical Review**: Two independent Flash High reviewers with mandatory consensus. Disagreement halts to `HUMAN_GATE`.
- **Zero Fallback**: Claude, Sonnet, Opus, GPT, and automatic Gemini 3.1 Pro fallbacks are strictly forbidden.

## Specialized Modular Skills
For focused runbooks, activate the specialized skills:
- [implementation-contract](../implementation-contract/SKILL.md): Scope contracts, allowed/forbidden paths, and delta retries.
- [progressive-testing](../progressive-testing/SKILL.md): 4-stage progressive testing and output compaction.
- [integration](../integration/SKILL.md): Multi-deliverable integration gates.
- [critical-review](../critical-review/SKILL.md): Two-key independent critical review.
- [evidence-validation](../evidence-validation/SKILL.md): Evidence ledger and acceptance eligibility.

## Efficiency Pass v2 — Runtime & Context Optimization

1. **Pre-Context Output Gate & Large File Guard**:
   - `TOOL_OUTPUT_LIMITS`: max 64 KB (65,536 bytes) or 300 lines inline output.
   - Large file dumps (`cat`, `jq '.'`) on files > 200 KB are blocked by `Large File Guard`.
   - Massive outputs are intercepted before entering context, written to `.agents/artifacts/outputs/output-<id>.log`, and replaced with a compact `[OUTPUT_TRUNCATED]` preview packet.

2. **Reactive Wakeup & Polling Discipline**:
   - Long-running commands (>10s) become background tasks.
   - **Do NOT poll `manage_task(Action='status')` in a loop**. The Antigravity CLI runtime provides **Reactive Wakeup** upon task completion. Stop calling tools (yield) to wait.
   - Polling is capped by `POLLING_POLICY` (minimum 15s backoff, budget of 3 polls). Rapid polling is hard-blocked with `POLLING_OVERHEAD`.

3. **Heavy-Work Disposable Subagents (`HEAVY_EXECUTION`)**:
   - High-volume tasks (campaigns, benchmark suites, massive candidate sweeps) run in isolated disposable subagents.
   - Context Firewall: raw logs remain on disk; worker returns only the standardized compact packet (`STATUS`, `COMMANDS_RUN`, `KEY_METRICS`, `TOP_FINDINGS`, `REGRESSIONS`, `ARTIFACT_PATHS`, `RECOMMENDED_NEXT_STEP`).

4. **Runtime Evidence Automation**:
   - `PostToolUse` and `output-gate-runner` capture exit codes, test counts, and durations into the Evidence Ledger automatically.
   - Models must never waste tokens manually editing `active-state.json` to record test execution facts.

5. **Shell Parsing & Anti-Obfuscation Boundary**:
   - The shell scanner deterministically isolates actual file redirection (`>`, `>>`) from language tokens (`=>`, `>=`, `<=`, `>>` shift) and strings.
   - Obfuscation via encoding (`base64 -d`, `xxd -r`) to mutate out-of-scope files is strictly blocked. Workers must reformulate using safe, authorized paths.

## Efficiency Pass v3 — Native Tools First & Evidence Freshness

1. **Native Tools First, Shell for Execution**:
   - Prefer native tools by default:
     - `view_file` for reading files
     - `grep_search` for code/text search
     - `find_by_name` for file/directory discovery
     - `replace_file_content` / `write_to_file` for editing and creating files
     - `run_command` for test, typecheck, build, lint, benchmark, and heavy execution
   - Shell fallback is permitted when native tools fail or query is unsupported.
   - Avoid routine shell usage for `cat`, `grep`, `find`, `ls`, or `sed -n`.

2. **Deterministic Shell Intent Classification & Overuse Diagnostics**:
   - `run_command` is classified into intent categories (`SHELL_READ`, `SHELL_SEARCH`, `SHELL_DISCOVERY`, `SHELL_EDIT`, `SHELL_VALIDATION`, `SHELL_TEST`, `SHELL_BUILD`, `SHELL_HEAVY_EXECUTION`, `SHELL_GIT_INSPECTION`, `SHELL_SCRIPT`, `SHELL_OTHER`).
   - `SHELL_OVERUSE` flags excessive shell inspection without hard blocking test/build/benchmark executions.
   - `EXPLORATION_OVERHEAD` tracks excessive reading before the first mutation.

3. **Mutation Tracking & Evidence Freshness**:
   - Mutations (`replace_file_content`, `write_to_file`) increment `mutationSeq` and record affected paths.
   - Evidence records carry `mutationSeq` at time of validation.
   - Fresh evidence (`exitCode: 0`) is reused without duplicate execution.
   - Subsequent code mutations invalidate affected package scopes (e.g. core edits invalidate core and app tests; docs edits preserve code test freshness).

## Efficiency Pass v5 — Direct Action Fast Path

1. **Direct Operational Fast Path (`DIRECT_ACTION`)**:
   - User requests for routine operations ("commita", "pusha", "commita e pusha", "mostra o git status", "mostra o diff", "roda os testes", "roda o typecheck", "roda o build", "executa esse script") bypass intake, planning, delegation, acceptance, and review.
   - State transitions directly: `INTAKE` / `CLASSIFIED` -> `DIRECT_ACTION` -> `EXECUTING` -> `DONE` or `BLOCKED`.

2. **Zero Subagents & Exact Intent Boundary**:
   - Subagents are strictly prohibited (`subagentsAllowed: false`).
   - Exact Intent Boundary: no unsolicited refactoring, whitespace cleaning, or repository exploration.
   - Any unexpected side quest or file edit attempt is blocked with `DIRECT_ACTION_SIDE_QUEST`.

3. **Deterministic Git Transaction Runner & Git Effect Taxonomy**:
   - Unified runner `.agents/hooks/git-operation.mjs` supports `status`, `diff_summary`, `commit`, `push`, `commit_push` in 1 grouped call.
   - Readonly, index-only, metadata-only, and remote-only git operations do NOT increment `mutationSeq`, preserving test evidence freshness. Worktree-mutating git operations (`checkout`, `merge`, `pull`) increment `mutationSeq` and invalidate evidence.
   - Staging enforces safe scope: unexpected sensitive files block staging rather than using `git add .` blindly.
   - Idempotency & Partial Failure: push failures preserve existing commits so retries only execute push. Hook failures halt cleanly to `DIRECT_ACTION_BLOCKED` without auto-fix side quests.
