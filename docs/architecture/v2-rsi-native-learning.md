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


## V2 delegated execution bridge — new implementation checkpoint

The neutral adapter `runtime/delegation/v2-native-execution.mjs` now exposes
`executeNativeDelegatedWork(...)` as an **internal** executable path. It uses
the real isolated clone and Codex/Antigravity process executors where available,
but **does not invoke the V1 delegation broker, V1 Work Lease, or V1 artifact
promotion**. The `v2/**` import boundary remains intact.

Facts checked before execution:
- Global Home Project/active Work/generation/runtime image and exact matching provider
  session observation; a caller-supplied actor string alone does not establish Work authority
- Validated implementation-only v2 delegation request (cross-provider, no network or recursive
  delegation), exact source fingerprint/HEAD, and a supported discovered target executor
- V2 mutation authorization with live writer exclusion at the Project's canonical workspace
- A new global `DELEGATED_MUTATION` Operation is recorded before the external worker
  starts, then the actor/session/Work are rechecked; only the **same** Operation may appear as
  the expected live writer

The worker executes in a hardened independent Git clone, with no remotes,
no canonical checkout editing and an enforced mutation scope. The adapter
checks the canonical workspace and Git boundary, the delegated clone boundary,
staged changes **and ignored files** (which ordinary Git status can miss).
Allowed file bytes are bounded, rehashed and stored as a content-addressed
candidate in the Orchestra Home blob store. The native Operation terminates
`SUCCEEDED` only when the candidate and cleanup have succeeded. Failure or
uncertain cleanup cannot manufacture a success. Canonical promotion is **not**
performed automatically.

The tests `tests/runtime/v2-native-delegation.test.mjs` exercise actual Home
SQLite Project/Work/Operation state and an actual isolated Git clone using a
controlled worker fixture on the CI platforms. Their worker fixture is a
**test double, not native AGY/Codex field evidence**.

### Remains release-blocking

- Integrate this bridge at an actual authenticated V2 provider/control-plane
  route-selection boundary. The current function is an internal service, not a
  published end-user command or a verified production orchestration workflow.
- The Home-owned RSI journal now supports an **internal** delegated decision
  receipt before execution and a terminal receipt afterward, linked to the
  exact global Operation and a content-addressed artifact. On reopening Home,
  `nativeRsi.listObserved()` rechecks the terminal Operation, immutable Work
  identity, artifact bytes/digest and sanitized selected route; tampered blobs
  cannot count toward training. Direct-only provider hooks still report only
  `DIRECT_WORK`. This is integration capability, **not field provider evidence**.
- Connect real authenticated provider/control-plane route selection to the
  internal delegated service. Record factual executor readiness and verify
  process provenance from actual native Codex/AGY operation, not a controlled
  test fixture. `DELEGATED` must not be inferred merely from a requested route,
  a fake executor or manually assembled Home contents.
- Implement restart-safe owner liveness and recovery of interrupted delegated
  Operations/candidate uploads, with bounded terminal states and cleanup proof.
- Supply source-bound, nontrivial TRAIN/EVALUATE/HOLDOUT across genuine Project
  lineages after the two-route field path exists, then re-freeze SHA/Runtime
  Image, rerun native 12/12 and all canonical gates.

**Current disposition: development integration slice only. RSI field gate
remains UNKNOWN, CUTOVER_NOT_READY.**

## Follow-up: delegated Operation crash/redispatch fence (PR #72)

The native delegation bridge now derives an Operation identity from the immutable
(Project ID, Work ID, generation, delegation ID) tuple. The Home SQLite
`operations.begin` transaction remains the final concurrency fence. Once an
Operation has been recorded, retries — even after success, UNKNOWN terminal,
process restart, or a changed request body using the same delegation ID — must
**not** execute another worker. A `NATIVE_DELEGATION_ALREADY_RECORDED`
response is a fail-closed outcome, **not** an idempotent second success and not
a request to release the mutation lock. A new generation requires the normal
Work-control decision; a new delegation ID must be treated as a distinct
operator-authorized action, not an automatic retry workaround.

The bridge also records a birth-identity-bound LOCAL_PROCESS runtime owner in
the Home owner store before opening the delegated Operation, and maintains
heartbeats against that exact owner while the controller executes the worker.
Missing process identity, heartbeat failure, or owner conflict cannot issue a
successful delegated RSI receipt. Existing V2 liveness assessment can now
observe the controller process as MATCH/ABSENT/MISMATCH/UNAVAILABLE instead of
being forced into RUNTIME_OWNER_MISSING for every delegation.

**This is NOT full interrupted-worker recovery**: the isolated clone must be
registered durably and proven cleaned or preserved, and the child-provider
lifecycle must be correlated independently before any automatic stale cleanup
or retry is safe. A controlling process dying is not by itself proof that an
external worker exited. The managed workspace inspector now explicitly rejects the canonical
Project root as cleanup proof for `DELEGATED_MUTATION`; absent a matching
durable managed-clone record it returns `UNKNOWN` and the global reconciler
requires a human gate without terminalizing the operation. Direct provider
Project-root recovery remains unchanged. The native RSI field gate remains unverified;
software CI alone does not establish genuine legal route alternatives or
independent TRAIN/EVALUATE/HOLDOUT field observations.
