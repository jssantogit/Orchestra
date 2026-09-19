import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

export const CODEX_SESSION_AUTHORITY_SCHEMA = "orchestra.codex-session-authority.v1";
export const CODEX_SESSION_HANDOFF_SCHEMA = "orchestra.codex-session-handoff.v1";
export const CODEX_SESSION_HANDOFF_STATUSES = Object.freeze({
  ARMED: "ARMED",
  CLAIMED: "CLAIMED",
  CANCELLED: "CANCELLED",
});
export const CODEX_SESSION_HANDOFF_MODE = "MILESTONE_BOUNDARY";
export const CODEX_SESSION_AUTHORITY_STATUSES = Object.freeze({
  ACTIVE: "ACTIVE",
  TRANSFERRING: "TRANSFERRING",
});

const QUIESCENT_STATES = new Set(["INTAKE", "DONE", "BLOCKED", "HUMAN_GATE"]);
const RUNTIME_STATE_DIR = ".codex/orchestra-state";
const FORBIDDEN_CAPSULE_KEYS = new Set([
  "transcript", "transcripts", "transcript_path", "messages", "prompt", "prompts",
  "reasoning", "thinking", "chainOfThought", "chain_of_thought", "stdout", "stderr",
  "credentials", "secret", "secrets", "environment", "env", "raw", "rawContent", "raw_content",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(stable(value)),
  ).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function clean(value, max = 500) {
  const text = String(value || "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function recordBody(record = {}) {
  const body = { ...record };
  delete body.record_hash;
  return body;
}

function finalizeRecord(record = {}) {
  const body = stable(recordBody(record));
  return { ...body, record_hash: digest(body) };
}

function validateHashedRecord(record, schema) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { valid: false, reason: "MISSING_OR_INVALID" };
  }
  if (record.schema !== schema) return { valid: false, reason: "SCHEMA_MISMATCH" };
  const expected = digest(stable(recordBody(record)));
  if (record.record_hash !== expected) return { valid: false, reason: "HASH_MISMATCH" };
  return { valid: true, reason: null };
}

function sanitizeCapsule(value, path = "capsule") {
  if (Array.isArray(value)) return value.map((item, index) => sanitizeCapsule(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 2000 ? value.slice(0, 2000) : value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CAPSULE_KEYS.has(key)) {
      throw new Error(`CODEX_SESSION_HANDOFF_FORBIDDEN_CAPSULE_FIELD:${path}.${key}`);
    }
    out[key] = sanitizeCapsule(child, `${path}.${key}`);
  }
  return out;
}

function paths(repoRoot) {
  const root = resolve(repoRoot);
  return {
    root,
    activeState: join(root, RUNTIME_STATE_DIR, "active-state.json"),
    activeContract: join(root, RUNTIME_STATE_DIR, "active-contract.json"),
    authority: join(root, RUNTIME_STATE_DIR, "session-authority.json"),
    handoff: join(root, RUNTIME_STATE_DIR, "session-handoff.json"),
    claimLock: join(root, RUNTIME_STATE_DIR, "session-handoff.claim.lock"),
    telemetry: join(root, ".codex/orchestra-telemetry/events.jsonl"),
  };
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function appendTelemetry(path, event) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ timestamp: nowIso(), ...event }) + "\n", "utf8");
  } catch {}
}

function gitOutput(root, args, { encoding = "utf8" } = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
