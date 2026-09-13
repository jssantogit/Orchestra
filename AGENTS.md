# Repository Guidance

This file contains durable repository rules for the Orchestra project itself. It is intentionally provider-neutral; runtime-specific control planes and agent instructions are located under `runtimes/codex/` and `runtimes/antigravity/`.

## Scope & Non-Destruction

- Make the smallest coherent change that satisfies the approved task.
- Preserve unrelated local files, tests, fixtures, and documentation.
- Never run destructive git commands (`git clean`, `git reset --hard`, destructive checkouts).
- Never commit secrets, credentials, environment files, or runtime session logs.

## Runtime Isolation Invariant

- Maintain strict separation between the Codex runtime (`runtimes/codex/`) and the Antigravity runtime (`runtimes/antigravity/`).
- Do not mix model providers, agent definitions, or runtime-specific routing policies across runtimes.
- Any shared concepts must remain in `shared/` as documentation, contracts, or templates without creating runtime coupling.

## Verification

- Run focused deterministic tests for any changed behavior.
- Before committing or pushing, verify that all test suites pass:
  - Codex policy tests: `node --test runtimes/codex/tests/routing-policy.test.mjs`
  - Antigravity policy tests: `node --test runtimes/antigravity/tests/routing-policy.test.mjs`
  - Antigravity hook tests: `node --test --test-concurrency=1 runtimes/antigravity/tests/hooks.test.mjs`
  - Cross-runtime firewall: `node --test tests/cross-runtime/cross-runtime-firewall.test.mjs`
  - Contamination check: `node scripts/contamination-check.mjs`
  - Repository health: `./scripts/doctor.sh`
- Run `git diff --check` to ensure no whitespace or formatting issues.

## Delivery Safety

- Do not commit or push without explicit approval and passing verification gates.
- Ensure no private paths, API keys, or unapproved runtime state artifacts are staged.
