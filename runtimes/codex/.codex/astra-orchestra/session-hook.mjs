import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  authorizeCodexSession,
  enterCodexSession,
} from "./session-authority.mjs";
function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function parsePayload() {
  const raw = readStdin();
  if (!raw.trim()) return { ok: false, reason: "CODEX_HOOK_INPUT_MISSING", payload: {} };
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, reason: "CODEX_HOOK_INPUT_INVALID", payload: {} };
    }
    return { ok: true, reason: null, payload };
  } catch {
    return { ok: false, reason: "CODEX_HOOK_INPUT_MALFORMED", payload: {} };
  }
}

function repoRootFrom(cwd) {
  const base = resolve(String(cwd || process.cwd()));
  try {
    const root = execFileSync("git", ["-C", base, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (root) return resolve(root);
  } catch {}

  let cursor = base;
  while (true) {
    if (existsSync(join(cursor, ".codex"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return base;
    cursor = parent;
  }
}


function sessionStartOutput(context, { stop = false, stopReason = null, systemMessage = null } = {}) {
  const output = {
    continue: !stop,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };
  if (stopReason) output.stopReason = stopReason;
  if (systemMessage) output.systemMessage = systemMessage;
  return output;
}

function preToolDeny(reason) {
  return {
    systemMessage: "Orchestra blocked this tool because this Codex session does not own current project orchestration authority.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function handleSessionStart(repoRoot, payload) {
  const entered = enterCodexSession(repoRoot, {
    sessionId: payload.session_id,
    source: payload.source || null,
  });

  if (!entered.authoritative) {
    return sessionStartOutput(
      [
        "ORCHESTRA CODEX SESSION HANDOFF REQUIRED [NON-AUTHORITATIVE].",
        "This Codex session does not own project orchestration authority.",
        "Do not execute project tools and do not ask the user to edit Orchestra state or copy a session ID.",
        "The previous factual main session must arm the managed boundary handoff after the current milestone is quiescent; then this session can claim automatically on a new SessionStart.",
        `Handoff status: ${entered.reason || "NO_VALID_HANDOFF"}.`,
        "No current Scope Contract, Evidence Ledger, worker identity, retry state, or continuation capsule is exposed to this session.",
      ].join(" "),
      { systemMessage: "Orchestra: this Codex session is not the current project orchestrator." },
    );
  }

  if (entered.claimed) {
    return sessionStartOutput(
      [
        "ORCHESTRA CODEX SESSION AUTHORITY HANDOFF CLAIMED [MILESTONE BOUNDARY].",
        `This session is now the factual main Codex orchestrator for lineage ${entered.authority.lineage_id}, generation ${entered.authority.generation}.`,
        "The prior milestone is sealed. Previous task scope, evidence, retries, workers, transcript, prompts, reasoning, and model summaries are not current-task authority.",
        "Runtime state is INTAKE. Classify the user's next milestone from scratch.",
        `Boundary capsule: ${JSON.stringify(entered.capsule || {})}`,
      ].join(" "),
    );
  }

  const authorityContext = [
    `ORCHESTRA CODEX SESSION AUTHORITY [AUTHORITATIVE]: lineage=${entered.authority.lineage_id}; generation=${entered.authority.generation}; source=${entered.authority.source}.`,
    "The factual session_id from Codex owns project tool authority for this lineage.",
    "Session authority does not import transcript, reasoning, Scope Contract, Evidence Ledger, or worker context. Use the provider-native Orchestra state modules for task facts.",
  ].join("\n");
  return sessionStartOutput(authorityContext);
}

function handlePreToolUse(repoRoot, payload) {
  const decision = authorizeCodexSession(repoRoot, payload.session_id);
  if (decision.allowed) return null;
  return preToolDeny(
    `CODEX_SESSION_AUTHORITY_DENIED:${decision.reason || "UNKNOWN"}. `
    + "Only the factual main Codex session may execute project tools. If the user requested a fresh chat, arm/claim the managed Orchestra session handoff instead of editing authority state manually."
  );
}

function handleUserPromptSubmit(repoRoot, payload) {
  const decision = authorizeCodexSession(repoRoot, payload.session_id);
  if (decision.allowed) return null;
  return {
    decision: "block",
    reason: `CODEX_SESSION_AUTHORITY_DENIED:${decision.reason || "UNKNOWN"}. This session is not the factual Orchestra root. Continue in the current main session or complete the managed boundary handoff.`,
  };
}

function main() {
  const parsed = parsePayload();
  if (!parsed.ok) {
    // PreToolUse treats exit code 2 as a hard block. SessionStart reports the
    // hook failure instead of silently manufacturing session identity.
    process.stderr.write(`Orchestra Codex session hook failed closed: ${parsed.reason}\n`);
    process.exitCode = 2;
    return;
  }

  const payload = parsed.payload;
  const repoRoot = repoRootFrom(payload.cwd);
  const event = String(payload.hook_event_name || "");

  if (event === "SessionStart") {
    console.log(JSON.stringify(handleSessionStart(repoRoot, payload)));
    return;
  }
  if (event === "PreToolUse") {
    const output = handlePreToolUse(repoRoot, payload);
    if (output) console.log(JSON.stringify(output));
    return;
  }
  if (event === "UserPromptSubmit") {
    const output = handleUserPromptSubmit(repoRoot, payload);
    if (output) console.log(JSON.stringify(output));
    return;
  }

  // This command is wired only to SessionStart, PreToolUse, and UserPromptSubmit. Unknown events
  // fail closed rather than silently acquiring authority semantics.
  console.log(JSON.stringify({
    continue: false,
    stopReason: `CODEX_SESSION_HOOK_UNEXPECTED_EVENT:${event || "MISSING"}`,
    systemMessage: "Orchestra Codex session hook received an unexpected event.",
  }));
}

main();
