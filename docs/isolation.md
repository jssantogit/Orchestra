# Cross-Runtime Isolation & Firewall

Orchestra hosts two independent multi-agent runtimes:
1. **Codex Runtime**: Built for OpenAI models (Terra / Luna / Sol / Astra).
2. **Antigravity Runtime**: Built for Gemini models (Flash Low / Medium / High).

---

## 1. The Isolation Invariant

- **Zero Mixing of Control Planes**: The Codex control plane runs exclusively on OpenAI models and has no runtime dependencies on Antigravity hooks, state files, or Gemini workers.
- **Zero Mixing of Agent Models**: Antigravity routing never selects GPT models or falls back to external providers.
- **Shared Concepts, Not Shared Coupling**: Principles, contracts, and handoff formats are shared conceptually in `shared/`, but neither runtime imports the other's operational code.

---

## 2. Cross-Runtime Firewall Testing

To permanently prevent accidental provider mixing, Orchestra maintains automated firewall tests in `tests/cross-runtime/cross-runtime-firewall.test.mjs` and `scripts/contamination-check.mjs`:

- **Codex Active Runtime Scan**:
  - Scans `.codex/config.toml`, `.codex/astra-orchestra/INSTRUCTIONS.md`, `.codex/astra-orchestra/routing-policy.mjs`, and `.codex/agents/*.toml`.
  - Asserts zero active imports or routes matching `gemini-`, `flash-worker`, `flash-orchestrator`, or `ALL-GEMINI`.
- **Antigravity Active Runtime Scan**:
  - Scans active routing definitions in `.agents/skills/orchestra/routing-policy.mjs` and agent definitions in `.agents/agents/*.md`.
  - Asserts zero active routes selecting `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol`, or `gpt-6-astra`.

---

## 3. Privacy & Secret Safeguards

- Operational runtime state (`.agents/state/`, `.agents/telemetry/`, `.agents/artifacts/`) is excluded from version control via `.gitignore`.
- Raw session JSONL transcripts, token traces, and private user credentials must never be committed.
- Pre-commit scanning verifies that local absolute paths (`/root/`, `/home/`, Android storage paths) and sensitive tokens are absent from the repository.
