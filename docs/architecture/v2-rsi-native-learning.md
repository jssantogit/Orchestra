# V2-11 Native RSI — decision/outcome evidence contract (Draft)

Status: implementation in progress in PR #71, stacked on #70. **NOT READY for release.**

## Problem reproduced

The existing `v2/rsi/policy-store.mjs` persists caller-supplied candidates. The existing promotion evaluator checks train/evaluate outcomes and scopes, but not whether every proposed selector was actually chosen within immutable legal execution choices. It can accept an unobserved route preference in a manually supplied candidate. `v2/experience/recorders.mjs` writes provider terminal Experience in PROJECT scope, without binding a legal choice set and a factual selected policy route to that terminal result. The result is not legitimate candidate-training provenance.

The old 27 sanitized Experience records across four lineages remain useful historical facts, but they cannot be upgraded by editing their scope or inferring missing selection context.

## Bounded native implementation slice

`v2/rsi/native-learning.mjs` is a **pure fail-closed TRAIN reducer**, not an authority or a trusted ingestion API. It:
- requires two or more distinct declared TRAIN lineages, observed operation identities, explicit immutable route sets and a selected route belonging to the observed legal subset;
- requires sanitized decision and terminal-outcome receipt references plus factual success and numeric metrics;
- rejects raw fields, unknown provenance keys, repeated operation identities, reused receipts, data from EVALUATE/HOLDOUT, conflicting route choices and caller-authored policy selectors;
- derives only an observed `DOMAIN` `routePreference`, without changing legal allowlists, capabilities or governance;
- emits a deterministic derivation digest and an unactivated CANDIDATE. It has **no permission** to persist, activate, generalize or mark release readiness.

**A sha256 digest is not a trusted attestation.** Any caller could present a structurally valid fictitious observation. Never use this pure function alone to issue a release `VERIFIED` record.

## Remaining native requirements (release blocking)

1. **Factual decision capture.** At a real control-plane decision boundary, record the immutable legal choices, actual selected route, Work generation, Runtime Image, Project lineage and Operation identity. No conversation-local or provider-claimed governance authority.
2. **Terminal correlation.** Join the exact prior decision to terminal Work/Operation journal outcomes. Only verified native provider or owner evidence may assign success; an unknown terminal state must fail closed. Persist the sanitized versioned observation atomically/idempotently in global Home, without raw prompts/tool payloads.
3. **Cross-project generalization.** A trusted reconciler re-reads durable receipts and Projects/lineages, verifies independent identities and scope eligibility, and constructs sanitized DOMAIN or GLOBAL_CANDIDATE observations. No request-selected scope or lineage counts.
4. **Deterministic TRAIN-only candidate derivation.** Consume those authenticated records with a frozen predeclared gate. Persist a candidate with source digest and derivation receipt that can be re-read and compared to the original immutable TRAIN set. Existing manually inserted candidates do not qualify.
5. **Independent EVALUATE and HOLDOUT.** Score the derived candidate on disjoint observed lineages, with fixed eligibility and performance criteria. Verify each selected route was actually applied within legal choices, without learning from EVALUATE/HOLDOUT. Counterexamples, insufficient telemetry, empty legal choices, and unsupported changes fail closed.
6. **Release gate.** The canonical `rsiReplay` probe re-opens Home and verifies the entire chain before emitting `trainVerified`, `evaluateVerified` and `holdoutVerified`. Never relax `evaluateCutoverReadiness()` or `validateCutoverReleaseEvidence()`.

## Identity, regression and deployment boundaries

Use test-first changes and the V2 Ubuntu/Windows + V1 regression gates. Changes to software HEAD invalidate the previous HEAD-bound runtime/field/probe evidence. Run all 12 native provider scenarios and all factual readiness probes again **only after a final new HEAD / Runtime Image freeze**.

Do not merge PR #70/#71, cut over production, publish, tag, migrate real Tsuzuki or remove V1 without operator authorization. Current #70 remains `CUTOVER_NOT_READY`; PR #71 is a bounded technical workstream only.

## Implemented native journal and evaluator (PR #71)

The global SQLite wrapper now provides `state.nativeRsi` for real Codex and Antigravity mutation hooks:

1. After authorizing and persisting a Work/Operation + native correlation, PreToolUse records the selected direct route, the exact Work generation and image pin. The journal queries authoritative Project/Work/Operation and provider-correlation records rather than trusting hook payload fields.
2. PostToolUse, **after official terminalization**, records the factual result. `UNKNOWN` is not an acceptable trained outcome. Failed native outcomes remain available to the evaluator rather than being silently filtered out.
3. The journal is persisted in `rsi_native_observations` in Orchestra Home SQLite. It maintains immutable decision and terminal digests, rejects conflicting replays and rechecks the persisted operations when collecting cross-project observations.
4. `v2/rsi/native-pipeline.mjs` constructs a sanitized DOMAIN view of native observations without rewriting Project Experience; deterministic lineage cohorts TRAIN/EVALUATE/HOLDOUT are derived by a source-controlled seed. It derives only from TRAIN, validates disjoint EVALUATE and HOLDOUT with fixed success/duration criteria, and persists a separately versioned receipt binding training sources to a candidate record.
5. The canonical `rsiReplay` probe now accepts only `{home,policyId,revision}` and replays from Home with the exact expected Runtime Image; hand-authored cohort membership, gate thresholds and manually inserted candidates lacking native training receipts are rejected.
6. The explicit training entrypoint is `node v2/rsi/native-train-cli.mjs --home <OrchestraHome> --runtime-image <exactImage> --policy-id <id> --revision <integer>`. It does not activate or deploy any learned policy.

### Non-trivial choice prerequisite — **still blocking on current hooks**

The currently verified native provider hooks only execute `DIRECT_WORK`. Their durable decision receipts therefore truthfully contain only that legal route. A single immutable legal choice is **not evidence of optimization**. `deriveNativeRouteCandidate` now fails with `RSI_TRAIN_CHOICE_SPACE_INSUFFICIENT` rather than learning a tautological policy from this one-route configuration.

A future native execution selector must expose at least two **actually supported, immutable and permitted** routes at the same decision point, then bind the selected route to the terminal Operation. Do **not** hardcode `DELEGATED` as legal merely to make a test green; do not accept a caller-provided legal choice list at the release boundary. The route's real delegated executor and authority fencing must exist first. Both observational cohorts must execute the derived route, not just pass generic performance thresholds.

**Status:** software pipeline implemented; current one-route field setup does not produce qualifying learning evidence. The RSI release field gate is not green. The new software HEAD invalidates old provider/runtime proofs; only a fresh native field campaign on the new HEAD can close readiness.
