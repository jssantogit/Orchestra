# Repository Guidance

This file contains durable repository rules for the Orchestra project itself. It is intentionally provider-neutral; runtime-specific control planes and agent instructions are located under `runtimes/codex/` and `runtimes/antigravity/`.

## Scope & Non-Destruction

- Make the smallest coherent change that satisfies the approved task.
- Preserve unrelated local files, tests, fixtures, and documentation.
- Never run destructive git commands (`git clean`, `git reset --hard`, destructive checkouts).
- Never commit secrets, credentials, environment files, or runtime session logs.

## Runtime Isolation Invariant

- Keep the Core layer provider-neutral: provider runtimes may depend on `core/**`, while Core must not import or assume provider runtime APIs, model identifiers, hook payloads, or session fields.
- Keep provider adapters one-way into Core. The Codex runtime (`runtimes/codex/`) and Antigravity runtime (`runtimes/antigravity/`) must never depend on each other.
- Keep shared architectural principles in `shared/`; runtime-specific model choices, agent definitions, and routing policies stay inside their own runtime.

## Verification Strategy

Verification is proportional during implementation and exhaustive at milestone acceptance. Do not use release-grade full-repository verification as the default inner loop.

### Inner loop

- Drive behavior changes with focused deterministic RED -> GREEN tests.
- During implementation, run only the task's focused tests plus directly affected adjacent tests.
- Complete implementation and orchestrator/reviewer inspection before paying for long-running repository-wide gates.
- After review findings, rerun only the focused tests that prove each fix before escalating to broader verification.

### Task commit gate

- A normal task commit requires:
  - the task-declared focused test suite;
  - directly affected invariant/adjacent tests selected by the orchestrator or reviewer;
  - `git diff --check`.
- A full-repository gate is **not** required before every task commit.
- In orchestrated work, the orchestrator selects the smallest gate that is sufficient to prove the task. The implementer must not escalate to the full gate by default.
- Record the exact verification commands/results used for the task checkpoint.

### Repository-wide invariant exception

The orchestrator may require a full-repository gate before a task commit when the task changes a repository-wide invariant, including:

- central persistence schemas or migrations;
- generation fencing, neutral authority, or liveness contracts;
- runtime packaging, generated mirrors, or cross-runtime isolation boundaries;
- migration, cutover, or compatibility boundaries.

Classify the task as repository-wide **before** starting a long gate. Do not discover this only after repeated broad verification runs.

### Milestone checkpoint

- At a milestone checkpoint, run the milestone-wide v2 suite and the compatibility/portability gates required by the approved plan.
- Multiple coherent task commits may be accumulated before this checkpoint.
- Do not rerun an already-passing milestone gate after every small follow-up fix unless that fix invalidates the evidence the gate established.

### Final reviewed head / PR ready

Before marking a milestone PR ready for review or treating a head as a release/cutover candidate, run exhaustive verification on the exact reviewed head, including all repository-wide gates applicable to that milestone.

The baseline full-repository verification set includes:

- Codex policy tests: `node --test runtimes/codex/tests/routing-policy.test.mjs`
- Antigravity policy tests: `node --test runtimes/antigravity/tests/routing-policy.test.mjs`
- Antigravity hook tests: `node --test --test-concurrency=1 runtimes/antigravity/tests/hooks.test.mjs`
- Cross-runtime firewall: `node --test tests/cross-runtime/cross-runtime-firewall.test.mjs`
- Contamination check: `node scripts/contamination-check.mjs`
- Repository health: `./scripts/doctor.sh`
- `git diff --check`

Also run the milestone's complete v2, portability, generated-artifact, and canonical CI gates when its approved plan requires them.

### Long-running verification discipline

- Long-running commands must have one persistent execution handle whose result can be recovered.
- Losing a handle does not authorize an automatic rerun. First determine whether the prior execution is still running or already completed and recover its result when possible.
- Tests that share mutable filesystem/database/process state must be serialized or isolated with independent temp directories/databases.
- If a full gate finds a failure, fix and prove the failure with the smallest focused test first. Rerun the full gate once the head is again a genuine final/checkpoint candidate.
- Do not repeat an expensive gate solely because its successful result was already observed and no subsequent change invalidated it.

## Delivery Safety

- Do not commit or push unless the active user-approved task/plan grants that action.
- Task commits require the applicable task commit gate above; they do not require the final full-repository gate unless classified as a repository-wide invariant change.
- Push, PR-ready, release, merge, and cutover remain explicit operator/plan gates and must satisfy the verification level assigned to that boundary.
- Ensure no private paths, API keys, or unapproved runtime state artifacts are staged.
