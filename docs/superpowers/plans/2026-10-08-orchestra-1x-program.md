# Orchestra 1.x Implementation Program

> **For agentic workers:** This is the program index. Execute each linked implementation plan with `superpowers:subagent-driven-development` or `superpowers:executing-plans`; do not treat this index as a substitute for the task-level plans.

**Approved design:** `docs/superpowers/specs/2026-10-08-orchestra-1x-direct-work-architecture.md`

## Program objective

Reform Orchestra from a milestone-accumulated dual runtime into an explicit provider-neutral kernel with fast Direct Work as the normal coding path, cheap bounded implementation/review workers, Work Lease authority independent of chat lifetime, provider adapters/model catalogs, and manifest-built self-contained runtimes — while preserving the factual evidence, fail-closed capability, provider isolation, and control-plane acceptance guarantees of the 0.10 baseline.

## Execution order

1. **Core Foundation** — `docs/superpowers/plans/2026-10-08-orchestra-1x-core-foundation.md`
   - canonical schemas + dependency-free generated validators;
   - provider-neutral domain contracts;
   - temporary generated runtime bridge;
   - first neutral module extraction;
   - provider-neutral firewall and performance vocabulary.

2. **Direct Work** — `docs/superpowers/plans/2026-10-08-orchestra-1x-direct-work.md`
   - Direct/Guided/Orchestrated mode policy;
   - Implementation Packet + Directed Discovery;
   - cheap implementer restrictions;
   - explicit test-mutation/failure policy;
   - independent diff-scoped cheap auditor;
   - candidate-bound acceptance;
   - CI/evidence + audit parallel fan-out;
   - shadow-to-default rollout.

3. **Work Lease Authority** — `docs/superpowers/plans/2026-10-08-orchestra-1x-work-leases.md`
   - workspace fingerprint + atomic locks;
   - generation-fenced Work Lease store;
   - session-independent candidate/evidence continuation;
   - Codex and Antigravity `session|dual|lease` migration;
   - session identity becomes provenance, not project ownership.

4. **Provider Adapters & Enforcement Decomposition** — `docs/superpowers/plans/2026-10-08-orchestra-1x-provider-adapters.md`
   - logical model roles + provider catalogs;
   - normalized provider adapters;
   - classification/escalation extraction;
   - capability/mutation authorization extraction;
   - candidate/evidence/stop decision extraction;
   - telemetry/event extraction;
   - giant runtime files become compatibility/composition facades.

5. **Packaging, Labs, Doctor & Release** — `docs/superpowers/plans/2026-10-08-orchestra-1x-packaging-and-release.md`
   - manifest-driven runtime ownership/builds;
   - unified installer primitives;
   - self-contained installed-runtime smoke tests;
   - project-state git-status cleanliness;
   - Dream/Jev zero-authority Labs;
   - manifest/schema-driven Doctor;
   - migration/release readiness;
   - operator-gated GitHub governance and stable release.

## Program gates

Each plan is a hard checkpoint. Do not start plan N+1 until plan N finishes its full regression/health gate on an exact commit.

During migration, retain two explicit rollback levers:

- `ORCHESTRA_DIRECT_WORK_MODE=off|shadow|on`
- `ORCHESTRA_AUTHORITY_MODE=session|dual|lease`

Do not remove these rollback modes until the final packaging/release plan and operator-approved compatibility decision.

## Spec coverage matrix

| Approved design area | Owning plan(s) |
|---|---|
| Problem/thesis: root intelligent, execution cheap, coordination minimal | Direct Work |
| Permanent trust/evidence/capability invariants | Core Foundation, Direct Work, Work Leases |
| Direct / Guided / Orchestrated execution modes | Direct Work |
| Sol control compression / implementation readiness | Direct Work |
| Versioned Implementation Packet | Core Foundation, Direct Work |
| NONE / DIRECTED / INVESTIGATIVE discovery | Core Foundation, Direct Work |
| Cheap implementer cannot reinterpret or investigate openly | Direct Work |
| Tests mutate only when explicitly authorized | Direct Work |
| Self-caused repair only; unrelated/uncertain returns to control | Direct Work |
| Independent cheap Quick Auditor, diff/task scoped | Direct Work |
| PASS / BLOCKING_FINDING only | Core Foundation, Direct Work |
| No worker-to-worker correction debate; Delta Packet retries | Direct Work |
| CI/evidence + audit parallel post-candidate verification | Direct Work |
| Control-plane-only candidate-bound acceptance | Direct Work, Provider Adapters |
| Session identity is provenance | Work Leases |
| Work Lease generation fencing / temporary mutation authority | Core Foundation, Work Leases |
| Fresh chat continuation without historical chat mutex | Work Leases |
| CI/evidence survives session changes | Work Leases |
| Provider-neutral executable core | Core Foundation, Provider Adapters |
| Codex / Antigravity one-way adapters | Provider Adapters |
| Logical model roles separate from concrete SKUs | Provider Adapters |
| Giant routing/enforcement files decomposed by ownership | Provider Adapters |
| Source/test/distribution separation | Packaging & Release |
| Canonical executable/versioned schemas | Core Foundation |
| Self-contained project runtimes | Core Foundation bridge, Packaging & Release final |
| Dream/Jev explicit zero-authority Labs | Packaging & Release |
| Manifest-driven Doctor instead of physical-path security contract | Packaging & Release |
| Performance/cost metrics and representative probes | Core Foundation, Direct Work |
| Incremental migration/no blind rewrite | All plans/program gates |
| 0.10 rollback/migration compatibility | Direct Work, Work Leases, Packaging & Release |
| Repository governance + release discipline | Packaging & Release operator gate |

## Cross-plan invariants

These apply to every implementation task:

1. `model != authority`.
2. Failed/missing tool execution is not evidence.
3. Acceptance is a control-plane transition backed by candidate-bound facts.
4. Workers do not coordinate workers in Direct Work.
5. Narrative context cannot grant capability, scope, lease, evidence, or acceptance.
6. Provider adapters may depend on core; core never depends on providers; providers never depend on each other.
7. Session/conversation identity is attributable provenance, not permanent project ownership.
8. A stale lease generation cannot mutate.
9. Installed runtimes must remain self-contained.
10. Labs have authority `NONE`.

## Performance success criteria

Representative normal product work must show the intended shape rather than only functional correctness:

- one bounded control resolve/investigation phase;
- one primary cheap implementer execution (plus bounded self-caused repair if necessary);
- no open-ended worker rediscovery chain;
- one independent cheap diff audit when policy requires it;
- CI/evidence and audit start independently after candidate creation;
- one control acceptance decision once required evidence is available;
- no historical chat handoff ceremony when no incompatible writer exists.

Track at least:

- control-model turns;
- worker turns;
- repository discovery operations;
- redundant reads;
- turns to first edit;
- delegations;
- model-to-model handoffs;
- validation wait structure;
- outcome;
- approximate cost when factual provider data is available.

## Final external-action gate

Code changes, tests, built runtimes, docs, migration and release-readiness checks may be prepared on implementation branches. Do not mutate repository governance, delete remote branches, merge the final 1.x implementation, or create a stable GitHub Release until the operator is shown the exact proposed actions and explicitly approves them.
