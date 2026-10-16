# Parallel Control Timeout Budget Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the provider control plane from timing out the neutral Parallel Implementation 2 broker before a bounded member execution can finish and the broker can terminalize its lifecycle.

**Architecture:** Keep the existing 120 s member execution timeout authoritative inside the neutral broker. Give the outer provider `parallel-cli` process a distinct bounded watchdog of five member budgets (600 s), leaving bounded lifecycle headroom for discovery, hardened clone preparation, inspection, artifact sealing, composition, cleanup, and structured terminalization. Apply the policy symmetrically to Codex and Antigravity; ordinary delegation and composite inspect/promote/discard retain their existing 120 s timeout.

**Tech Stack:** Node.js ESM, `node:test`, provider control-plane wrappers, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-15-parallel-implementation-2-design.md`

## Global Constraints

- Member timeout stays `120_000` ms.
- Parallel execute outer watchdog is bounded at `5 * 120_000 = 600_000` ms.
- `inspect`, `promote`, and `discard` keep the existing `120_000` ms provider-control timeout.
- Codex and Antigravity behavior must remain symmetric.
- No serial/manual fallback, authority relaxation, schema change, retry policy, or worker model change.
- Do not modify Tsuzuki in this hotfix.

## Review Focus

- A worker consuming nearly all 120 s must not be preempted by the provider wrapper before broker cleanup/terminalization.
- A truly stuck neutral CLI must still be bounded by the 600 s outer watchdog.
- Composite lifecycle actions must not inherit the longer execute watchdog.
- Codex and Antigravity must use the same timeout policy.
- Existing injected-CLI control-plane tests must continue proving no self-acceptance or fallback.

---

### Task 1: Separate parallel execute watchdog from member timeout

**Files:**
- Modify: `tests/delegation/parallel-control-plane-delegation.test.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/cross-provider-delegation.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/cross-provider-delegation.mjs`

**Interfaces:**
- Produce in each provider module: `resolveParallelCliTimeoutMs(action) -> integer milliseconds`.
- `execute` returns `600_000`.
- `inspect`, `promote`, and `discard` return `120_000`.
- `runInstalledParallelCli()` uses that resolver for its `execFileSync(..., { timeout })` option.

- [ ] **Step 1: Write RED regression** — extend `parallel-control-plane-delegation.test.mjs` to require both provider modules to expose the resolver and assert symmetric `600_000` execute / `120_000` lifecycle-action budgets.
- [ ] **Step 2: Run RED** — focused test must fail on v1.4.2 because the resolver does not exist and the installed wrapper still uses `DEFAULT_TIMEOUT_MS + 5_000` for every parallel action.
- [ ] **Step 3: Implement minimal production change** — add the resolver to both provider control planes and route the existing `execFileSync` timeout through it; do not alter broker member limits.
- [ ] **Step 4: Run GREEN** — focused control-plane tests pass.
- [ ] **Step 5: Run full regression** — canonical Orchestra CI, portable Ubuntu/Windows runtime checks, Doctor/firewall/contamination, release-readiness, and turn-economy remain green.
- [ ] **Step 6: Prepare PR** — document field reproduction (`spawnSync node.exe ETIMEDOUT`), exact root cause, TDD RED/GREEN evidence, and no Tsuzuki mutation.
