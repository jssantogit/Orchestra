# Milestone M — Codex Runtime Parity

Date: 2026-09-18

## Goal

Bring the OpenAI/Codex runtime to architectural parity with the governance capabilities that evolved first in Antigravity, without importing Antigravity operational code or pretending both providers expose identical runtime hooks.

Parity means equivalent safety properties and decision boundaries, not byte-for-byte implementation identity.

## Permanent isolation rule

Codex may share schemas, terminology, and documented contracts with Antigravity, but active Codex runtime code MUST NOT import from `runtimes/antigravity/.agents/**`.

Antigravity remains Gemini-only. Codex remains OpenAI-only.

## Capability map

| Capability | Codex implementation |
| --- | --- |
| deterministic routing | existing `routing-policy.mjs` |
| Scope Contracts / retry / acceptance | existing routing policy, extended by factual evidence module |
| first-class factual evidence | `evidence-contract.mjs` |
| delegated evidence promotion | `evidence-federation.mjs` |
| CI/provider evidence normalization | `evidence-provider-registry.mjs`, `evidence-watch.mjs`, `evidence-watch-runner.mjs` |
| attributable hypothesis/experiment feedback | `feedback-plane.mjs` |
| context and side-effect trust boundary | `trust-boundary.mjs` |
| bounded mechanical fast path | `mechanical-fast-path.mjs` |
| worker packet / context diet | `context-packet.mjs` |
| Dream-style offline exploration | `dream-lab.mjs` |
| project-local runtime lifecycle | `codex-runtime-manager.mjs`, `codex-runtime-cli.mjs` |
| runtime installer wrapper | `scripts/orchestra-codex-project.mjs` |

## Authority model

1. Terra is the Codex control plane and remains the only automatic acceptance owner.
2. Luna workers may implement and validate but cannot self-accept or spawn workers.
3. Sol is review/specialist analysis only.
4. Astra stays manual-only and requires explicit user approval.
5. Feedback records are observational metadata, never Evidence Contract authority.
6. Dream/offline exploration is zero-authority until an explicit human-approved canary record exists; even then it does not rewrite routing source automatically.
7. Provider-native transcript/context management remains provider-owned. Orchestra manages only bounded factual sidecars and packet references.
8. Remote/public side effects are default-deny unless the Scope Contract carries the matching capability or a narrowly defined Direct Action grants it.

## Evidence model

Evidence is append-only factual metadata. A requirement can only be satisfied by a record that:
- has a stable evidence identifier;
- has a known PASS/SUCCESS factual result;
- matches the required command/fact/provider;
- belongs to the current attempt when attempt-bound;
- is fresh for the current mutation sequence when mutation-sensitive;
- has non-low actor attribution confidence.

Delegated worker evidence is promoted into the parent ledger only through the federation boundary. Model prose is not evidence.

## Context diet

Codex packets must preserve a mandatory core:
- task/action/domain;
- Scope Contract;
- acceptance criteria;
- required evidence;
- current mutation/attempt/retry state;
- known blockers and Human Gate reason.

Auxiliary context is reference-oriented and bounded. Raw transcripts, full tool logs, chain-of-thought/reasoning, unrelated history, and secret material are not packet inputs.

Large output defaults:
- inline output gate: 64 KiB or 300 lines;
- use path/symbol/range references above the gate;
- search before opening large files when the decision only needs a local window.

## Dream parity

Codex does not import the Antigravity Dream runtime. Instead it receives a native offline lab:
- immutable sealed factual worlds;
- bounded candidate-policy records;
- deterministic replay inputs;
- zero-impact shadow decisions;
- explicit human-approved canary records;
- no automatic source rewrite, routing mutation, or external side effect.

This matches the safety/learning boundary while respecting provider/runtime differences.

## Codex project runtime lifecycle

Managed paths:
- `.codex/config.toml`
- `.codex/agents`
- `.codex/astra-orchestra`

Project-owned preserved paths:
- `.codex/orchestra-state`
- `.codex/orchestra-telemetry`
- `.codex/orchestra-artifacts`
- `.codex/orchestra-semantic`
- `.codex/runtime-management`

The Codex updater supports install, update, dry-run, doctor, version, diff-runtime, backups, rollback, quiescence checks, and legacy runtime adoption.

## Promotion/activation rules

No module introduced by Milestone M may:
- weaken the routing model/provider firewall;
- allow Terra to implement product code;
- allow workers to self-accept;
- convert model claims into factual evidence;
- auto-approve Astra;
- auto-promote Dream policies;
- bypass Scope Contracts, Human Gate, retry budgets, or side-effect capability checks.

## Verification

Milestone M requires:
- Codex parity unit tests;
- Codex runtime-manager installer/update/rollback tests;
- architecture invariants;
- cross-runtime firewall scan over all active Codex modules;
- contamination check;
- Doctor integration;
- CI integration.

