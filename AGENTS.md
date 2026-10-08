# Repository Guidance

This file contains durable repository rules for the Orchestra project itself. It is intentionally provider-neutral; runtime-specific control planes and agent instructions are located under `runtimes/codex/` and `runtimes/antigravity/`.

## Scope & Non-Destruction

- Make the smallest coherent change that satisfies the approved task.
- Preserve unrelated local files, tests, fixtures, and documentation.
- Never run destructive git commands (`git clean`, `git reset --hard`, destructive checkouts).
- Never commit secrets, credentials, environment files, or runtime session logs.

## Core & Runtime Isolation Invariant

- `core/` is executable provider-neutral Orchestra behavior. It must not import provider runtimes, embed concrete provider model IDs, depend on provider hook APIs, or make provider-specific session fields authoritative.
- Provider runtimes may depend one-way on their generated/local core payload or provider-neutral core contracts.
- Maintain strict separation between the Codex runtime (`runtimes/codex/`) and the Antigravity runtime (`runtimes/antigravity/`). Neither provider runtime may import, route to, or depend on the other provider runtime.
- Provider-specific model catalogs, hooks, tool semantics, and session mechanics remain inside their provider boundary.
- `shared/` remains suitable for provider-neutral documentation and non-executable reference material; executable shared behavior belongs in `core/`.

## Verification

- Run focused deterministic tests for any changed behavior.
- Before committing or pushing, verify that all test suites pass:
  - Codex policy tests: `node --test runtimes/codex/tests/routing-policy.test.mjs`
  - Antigravity policy tests: `node --test runtimes/antigravity/tests/routing-policy.test.mjs`
  - Antigravity hook tests: `node --test --test-concurrency=1 runtimes/antigravity/tests/hooks.test.mjs`
  - Core/provider firewall: `npm run test:firewall`
  - Contamination check: `npm run check:contamination`
  - Repository health: `./scripts/doctor.sh`
- Run `git diff --check` to ensure no whitespace or formatting issues.

## Delivery Safety

- Do not commit or push without explicit approval and passing verification gates.
- Ensure no private paths, API keys, or unapproved runtime state artifacts are staged.
