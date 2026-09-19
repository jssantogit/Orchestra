# Orchestra — Codex Runtime

This directory contains the OpenAI/Codex implementation of the Orchestra multi-agent orchestration framework.

```text
TERRA MEDIUM (Global Control Plane)
  ├─ classify action/domain and write scopeContract
  ├─ investigate → TERRA HIGH / XHIGH / MAX
  ├─ implement   → LUNA HIGH (simple) or LUNA MAX (normal)
  ├─ support     → LUNA MEDIUM (deterministic/bounded)
  ├─ critical review → SOL LOW; justified specialist → SOL MEDIUM
  ├─ manual packet → ASTRA MANUAL ONLY (explicit approval required)
  └─ validate evidence, integrate deliverables, accept or fail closed
```

---

## 1. Prerequisites

- OpenAI Codex CLI / IDE integration with support for custom subagents.
- Node.js v18+ (for deterministic routing policy evaluation and tests).

---

## 2. Directory Structure

- `.codex/config.toml` — Project-scoped Codex configuration file. Defines models, multi-agent flags, and default subagent reasoning.
- `.codex/astra-orchestra/INSTRUCTIONS.md` — Core instructions loaded into the session control plane.
- `.codex/astra-orchestra/routing-policy.mjs` — Deterministic routing policy, scope validation, and Terra acceptance.
- `.codex/astra-orchestra/evidence-*.mjs` — First-class factual evidence, federation, read-only inspection, provider registry, and explicit watch steps.
- `.codex/astra-orchestra/feedback-plane.mjs` — Attributable hypotheses/experiments with zero acceptance authority.
- `.codex/astra-orchestra/trust-boundary.mjs` — Context authority and side-effect capability enforcement.
- `.codex/astra-orchestra/mechanical-fast-path.mjs` — Bounded Luna Medium mechanical support.
- `.codex/astra-orchestra/context-packet.mjs` — Mandatory-core worker packets, reference budgets, output gate, and search-to-window.
- `.codex/astra-orchestra/dream-lab.mjs` — Isolated zero-authority replay/shadow lab with human-only Canary approval.
- `.codex/astra-orchestra/codex-runtime-manager.mjs` — Install/update/doctor/diff/backup/rollback lifecycle for project-local `.codex`.
- `.codex/agents/*.toml` — 9 specialized agent profiles:
  - `terra-high.toml`, `terra-xhigh.toml`, `terra-max.toml` (Investigation & decision escalation)
  - `luna-high.toml`, `luna-medium.toml`, `luna-max.toml` (Implementation workers)
  - `sol-low.toml`, `sol-medium.toml` (Critical review & specialist escalation)
  - `astra-manual.toml` (Manual-only consultation)

---

## 3. Configuration (`.codex/config.toml`)

The configuration sets `gpt-5.6-terra` with `medium` reasoning as the main session model, enables native multi-agent coordination, and points `model_instructions_file` to `astra-orchestra/INSTRUCTIONS.md`.

It specifies `gpt-5.6-luna` with `max` effort as the default subagent for non-trivial implementation.

If the repository also contains Antigravity skills under `.agents/skills/`, `config.toml` explicitly disables them by name to prevent cross-runtime contamination.

---

## 4. Routing & Profiles

| Action / Intent | Profile | Model / Effort | Purpose |
| :--- | :--- | :--- | :--- |
| `ORCHESTRATE`, `DIRECT_ACTION`, Intake | `terra-medium` | Terra / medium | Global control plane, planning, acceptance |
| `IMPLEMENT` (simple), `TEST`, `MECHANICAL_FIX` | `luna-high` | Luna / high | Small, conventional changes |
| `IMPLEMENT` (normal / complex), `INTEGRATE` | `luna-max` | Luna / max | Standard and complex feature development |
| Explicit bounded deterministic support | `luna-medium` | Luna / medium | Purely mechanical docs/formatting tasks |
| `INVESTIGATE` | `terra-high` | Terra / high | Root cause analysis & technical investigation |
| Justified deeper investigation | `terra-xhigh` | Terra / xhigh | Multiple hypotheses or complex algorithms |
| Exceptional investigation with evidence | `terra-max` | Terra / max | High effort investigation after failure |
| `REVIEW` with `CRITICAL` risk | `sol-low` | Sol / low | Independent post-acceptance review |
| Justified specialist escalation | `sol-medium` | Sol / medium | Deep technical specialist |
| Approved escalation packet | `astra-manual` | GPT-6 Astra / med | **Manual only** after explicit user approval |

---

## 5. Separation of Duties

- **Terra Medium** orchestrates, writes scope contracts, validates evidence, and accepts work. Terra never writes product code directly.
- **Luna** executes only the declared `taskDomain` and `scopeContract`. Luna never spawns subagents and cannot self-accept.
- **Sol** conducts independent reviews or specialist analyses. Findings are returned to Terra, never implemented directly by Sol.
- **Astra** is strictly manual-only; automated routes, retries, or fallbacks to Astra fail closed.

---

## 6. Direct Action Fast Path

Routine operational actions (`SHOW_STATUS`, `SHOW_DIFF`, `RUN_TEST`, `RUN_TYPECHECK`, `RUN_BUILD`, `RUN_SCRIPT`, `COMMIT`, `PUSH`, `COMMIT_PUSH`) execute directly within Terra without subagents or acceptance ceremonies. Nonzero exits are treated as blockers.

---

## 7. Tool Truthfulness: "FAILED TOOL IS NOT EVIDENCE"

A failed, missing, or blocked tool execution evaluates strictly to `UNKNOWN` or `BLOCKED`. It is never converted into success or "clean" status.

---

## 8. First-Class Evidence, Trust & Context Diet

`requiredEvidence` is part of the Scope Contract. Factual evidence is
attempt/mutation-bound and may be federated from delegated Luna validation into
Terra acceptance. Model prose and Feedback Plane declarations are never
evidence.

Remote/public side effects are default-deny unless an explicit Scope Contract
capability permits them. Worker packets preserve the governance core and bound
auxiliary context to references; raw transcripts/reasoning and large stdout are
not packet inputs.

The Codex Dream Lab is intentionally offline/shadow. It can replay bounded
policy candidates and create human-approved Canary records, but it cannot
rewrite routing source or activate itself.

---

## 9. Project Runtime Lifecycle

Existing Codex projects should use the source runtime manager instead of
manually replacing `.codex`:

```bash
node scripts/orchestra-codex-project.mjs update /path/to/project --dry-run
node scripts/orchestra-codex-project.mjs update /path/to/project
node scripts/orchestra-codex-project.mjs doctor /path/to/project
node scripts/orchestra-codex-project.mjs version /path/to/project
node scripts/orchestra-codex-project.mjs diff-runtime /path/to/project
node scripts/orchestra-codex-project.mjs evidence /path/to/project
node scripts/orchestra-codex-project.mjs rollback /path/to/project --backup latest
```

Managed code is limited to `.codex/config.toml`, `.codex/agents/`, and
`.codex/astra-orchestra/`. Project-owned state under
`.codex/orchestra-state/`, `.codex/orchestra-telemetry/`,
`.codex/orchestra-artifacts/`, `.codex/orchestra-semantic/`, and
`.codex/runtime-management/` survives update and rollback.

---

## 10. Validation & Testing

Run the complete Codex suite:

```bash
npm run test:codex
node --test tests/installers/codex-project-runtime-manager.test.mjs
node --test tests/architecture-invariants/codex-parity-authority.test.mjs
```

---

## 11. Limitations

- Does not support simultaneous parallel writers in the same workspace; the
  Codex Dream exploration budget therefore hard-caps active parallel branches
  at one.
- Codex does not emulate Antigravity engine hooks. Equivalent guarantees are
  exposed as deterministic native decision boundaries that the control plane
  consults.
- Remote-CI watching advances through explicit factual provider observations;
  the Codex runtime does not create a background credential-owning daemon.
- Requires OpenAI models with reasoning effort configuration support.
