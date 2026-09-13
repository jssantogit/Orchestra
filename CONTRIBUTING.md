# Contributing to Orchestra

Thank you for contributing to Orchestra. Orchestra is a local multi-agent orchestration framework for coding agents that supports multiple independent provider runtimes (Codex and Antigravity).

To maintain the architectural integrity, safety, and reliability of the project, all contributions must adhere to the following standards.

---

## 1. Strict Runtime Isolation (No Cross-Contamination)

Orchestra explicitly preserves two independent runtimes:
- **Codex Runtime (`runtimes/codex/`)**: Powered by OpenAI models (Terra / Luna / Sol / Astra).
- **Antigravity Runtime (`runtimes/antigravity/`)**: Powered by Gemini models (Flash Low / Medium / High).

### Firewall Invariants:
- **Never contaminate Codex with AGY**: Do not introduce Gemini models, Flash workers, Antigravity hooks, or ALL-GEMINI concepts into the Codex active runtime.
- **Never contaminate AGY with Codex**: Do not introduce GPT models (Terra, Luna, Sol, Astra) or Codex-specific control-plane logic into the Antigravity active routing.
- The shared principles live in `shared/` as conceptual architecture, contracts, and templates, **not** as unified runtime coupling.
- Cross-runtime firewall tests are enforced by `npm run test:firewall` and `scripts/contamination-check.mjs`. Any cross-provider contamination will fail CI.

---

## 2. No Secrets or Session Logs

- Never commit API keys, auth tokens, credentials, private paths (e.g. `/root/`, `/home/user/`), or personal machine details.
- Never commit active runtime execution state (`.agents/state/`, `.agents/telemetry/`, `.agents/artifacts/`), raw session JSONL transcripts, or model benchmark traces.
- All contributions must pass `scripts/doctor.sh` and local secret scans before submission.

---

## 3. Backward Compatibility & Generalization

- **No Project-Specific Hardcoding**: Do not hardcode project-specific monorepo paths (`packages/core`, `apps/web`) or proprietary domains into core routing policies. Keep them generalized (`CODE`, `UI`, `DATA`, `INFRA`, `TESTING`, `DOCS`, `RESEARCH`, `GENERAL`) and allow configurable extension.
- Specific domain examples belong exclusively under `examples/`.

---

## 4. Testing Requirements

All contributions must include deterministic offline unit tests that run without model API keys or active network dependencies:
- **Codex changes**: Must add/update deterministic tests in `runtimes/codex/tests/` (or `.codex/astra-orchestra/*.test.mjs`).
- **Antigravity changes**: Must add/update deterministic tests in `runtimes/antigravity/tests/` (or `.agents/skills/orchestra/*.test.mjs`, `.agents/hooks/*.test.mjs`).
- **Scripts / Tooling**: Must pass verification in temporary scratch fixtures.

Run the test suite locally:
```bash
npm test
# Or individually:
node --test runtimes/codex/tests/*.test.mjs
node --test --test-concurrency=1 runtimes/antigravity/tests/*.test.mjs
node --test tests/cross-runtime/*.test.mjs
node scripts/contamination-check.mjs
./scripts/doctor.sh
```

---

## 5. Adding Runtime-Specific Improvements

- When improving the **Codex** runtime, place changes inside `runtimes/codex/`, adhere to the separation of duties (Terra orchestrator / Luna worker / Sol reviewer / Astra manual), and update `docs/codex.md`.
- When improving the **Antigravity** runtime, place changes inside `runtimes/antigravity/`, adhere to the ALL-GEMINI architecture (Flash Medium orchestrator / Flash workers / Two-Key review), and update `docs/antigravity.md`.
- Clearly state in pull requests whether the change affects Codex, Antigravity, Shared Concepts, or Documentation.
