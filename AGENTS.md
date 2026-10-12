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
