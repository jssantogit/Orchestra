# Orchestra v2 Cutover Runbook

Status: operator-gated procedure for switching the default operating topology to Orchestra v2.

This runbook defines a **default-topology switch**, not a release authorization and not history erasure. A green CI run or a complete readiness record is necessary evidence, but neither is permission to merge, tag, publish, migrate additional real Projects, or remove v1 compatibility support.

## Target topology

Normal v2 operation is:

```text
registered Project
  -> thin provider shim
  -> global Orchestra launcher / control plane under Orchestra Home
  -> Project-scoped Work Unit + Operation authority
  -> globally installed Runtime Image pinned by Project ID
```

The global engine owns durable registry, Work/Operation state, runtime images, factual liveness/recovery, sanitized Experience, and learned-policy state. A registered Project retains its source tree and only the provider integration/configuration surface required to reach the global engine.

Project-local v1/runtime material is **compatibility or migration-only** after a Project is cut over. Normal v2 must not copy, install, or materialize a full local v2 governance runtime/brain inside each Project.

A provider session/conversation supplies factual actor provenance. **Work Lease/session handoff is not normal v2 authority**: the current Project-scoped Work Unit and its generation/runtime epoch are authoritative. No chat permanently owns a Project.

## Preconditions

Freeze the exact candidate head and collect the V2-11 readiness record. Do not continue unless all required fields are factual and current:

- exact candidate Git head;
- exact Runtime Image ID(s);
- global registry persistence/restart evidence;
- two independent Project lineages under one Orchestra Home;
- Orchestra self-host evidence;
- Codex and Antigravity field-evidence sets for the exact head/runtime;
- Windows plus POSIX evidence;
- migration/Tsuzuki F7 evidence;
- stale-owner recovery and dirty-preservation evidence;
- runtime upgrade + rollback evidence;
- Experience privacy + four-lineage RSI TRAIN/EVALUATE/HOLDOUT replay evidence;
- v1 compatibility evidence.

`FAILED`, `UNKNOWN`, missing, stale-head, stale-runtime, or mismatched-lineage evidence means **not ready**.

## Canonical readiness collection

Use `v2/cutover/readiness-evidence.mjs` as the canonical V2-11 collection boundary and `v2/cutover/readiness-probes.mjs` as the source-controlled factual probe module for the non-provider readiness families.

- The release-facing collector is `collectCanonicalCutoverReadinessFragment(...)`. It accepts probe **descriptors**, not caller callbacks. Each descriptor points to a probe module tracked in Git at the exact candidate `headSha`, and the **entire source checkout must be clean** before the module or any imported dependency is executed.
- The canonical production module `v2/cutover/readiness-probes.mjs` registers registry persistence, runtime lifecycle, reconciliation, Experience privacy, four-lineage RSI replay, migration/Tsuzuki F7, native Windows/POSIX, Project isolation and Orchestra self-host probes. Descriptor arguments locate factual state (for example Orchestra Home, Project/Operation IDs, migration Work IDs or runtime command IDs); they do not supply the facts being verified. Unknown or fact-shaped argument fields fail closed.
- A canonical probe module declares `orchestra.cutover-readiness-probe-module.v2`, registers the readiness family it can prove, and receives only the exact head/runtime identity plus JSON-safe target/configuration arguments. Its source SHA-256 is included in the sanitized evidence refs.
- A probe result is promoted to `VERIFIED` only when it reports `ok: true`, the exact head/runtime identity, structured facts, and one or more sanitized evidence references. Arbitrary runtime functions, caller-supplied booleans, prebuilt records, untracked modules, dirty source/dependencies, and modules from another Git head are rejected.
- Windows and POSIX runs may emit separate canonical fragments. Independent Project runs may also emit separate fragments. `mergeCanonicalCutoverReadinessEvidence(...)` accepts only canonical Git-bound fragments, combines only exact-identity evidence, and fails closed on stale identity, invalid evidence refs, conflicting records, probe errors, or noncanonical fragments.
- `collectCutoverReadinessFragment(...)` and `mergeCutoverReadinessEvidence(...)` are low-level composition/test primitives. Their output alone is **not** sufficient provenance for release readiness and must not be used as a substitute for the canonical Git-bound path.
- The `providers` readiness group is never accepted from a readiness fragment. It is derived only by the canonical six-scenario `evaluateProviderFieldEvidence(...)` evaluator for both Codex and Antigravity on the same exact head and Runtime Image.
- The merged `evidence` object is then passed to the existing `evaluateCutoverReadiness(...)` authority. Collection may make readiness stricter when collection/provenance errors exist; it does not override or weaken the evaluator.

Do not hand-author `VERIFIED` readiness objects or ad-hoc probe callbacks to bypass the collector. CI fixtures, mocks, direct adapter calls, operator attestations, historical provider records, or a previously green candidate are not substitutes for current factual probes.

A software or canonical-probe-module change changes the candidate head. When the head changes, provider field evidence and readiness fragments from the previous head become historical immediately and must not be merged into the new candidate.

## Cutover procedure

1. **Record the candidate identity.** Record exact branch/head, Runtime Image ID, canonical CI run IDs, provider field-evidence references, two independent Project lineage IDs, and self-host result.
2. **Verify global status.** Use the global Orchestra status/reconciliation commands for each registered Project. Persisted `RUNNING` is not liveness proof; unresolved liveness or dirty state blocks the cutover.
3. **Verify runtime pins.** Every target Project must reference an installed compatible Runtime Image and current instruction epoch. Runtime images are global; Projects store pins, not copied runtime brains.
4. **Verify thin shims.** Codex and Antigravity Project integrations must contain only their approved thin transport/configuration shims and point at the global launcher/control plane.
5. **Verify current Work authority.** A fresh provider session must attach to the factual current Work. A Project with no active Work enters the v2 INTAKE boundary; it does not inherit authority from another conversation.
6. **Verify stale fencing.** A provider observation from before an epoch change must be denied through the official stale-runtime fence.
7. **Verify recovery commands.** Recovery, dirty resolution, runtime upgrade and rollback are global control-plane operations. Do not repair authority by editing Project-local state files.
8. **Verify learning remains bounded.** An activated RSI policy may choose only among immutable legal execution choices and never grant capabilities, acceptance authority, or side-effect authority.
9. **Freeze evidence.** Store only sanitized evidence references/digests permitted by repository policy. Do not commit raw prompts, transcripts, provider session IDs, private source, secrets, machine-specific absolute paths, or hidden reasoning.
10. **Stop at the operator gate.** Present the exact readiness evidence for explicit operator approval.

## Operator gate

Explicit operator approval is required before any of the following:

- merging the v2 stacked PRs into the release line;
- changing the production/default cutover state for additional real Projects;
- creating a release tag or GitHub release;
- declaring v1 compatibility removed or unsupported.

CI success alone must never trigger these actions.

## Compatibility boundary

Do **not** delete or remove v1 source/runtime support as part of this cutover. V1 remains an explicit compatibility/migration state until a separately approved release gate says otherwise. Historical migration artifacts and preserved evidence remain auditable.

If the operator rejects or pauses cutover, follow `docs/release/v2-rollback-runbook.md` rather than modifying durable state by hand.
