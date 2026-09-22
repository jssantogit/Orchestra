import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CODEX_VERIFICATION_CONFIG = ".codex/orchestra-verification.json";

export function readCodexVerificationConfig(repoRoot) {
  try {
    const config = JSON.parse(readFileSync(join(repoRoot, CODEX_VERIFICATION_CONFIG), "utf8"));
    if (config?.schema !== "orchestra.codex-verification.v1"
      || !["CI_FIRST", "LOCAL_FOCUSED"].includes(config.mode)
      || !Array.isArray(config.heavyLocalCommands)
      || !config.heavyLocalCommands.every((name) => typeof name === "string" && /^[\w.-]+$/.test(name))
      || (config.mode === "CI_FIRST" && (
        typeof config.authoritativeGate !== "string" || !config.authoritativeGate.trim()
        || config.heavyLocalCommands.length === 0
        || (config.localHeavyAttempts !== undefined && config.localHeavyAttempts !== 0)
      ))) {
      return { valid: false, reason: "VERIFICATION_CONFIG_INVALID" };
    }
    return { valid: true, policy: config };
  } catch (error) {
    if (error?.code === "ENOENT") return { valid: true, policy: null };
    return { valid: false, reason: "VERIFICATION_CONFIG_UNREADABLE" };
  }
}

function shellWords(command) {
  const segments = [];
  let words = [];
  let word = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && i + 1 < command.length) { word += command[++i]; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char) || ";|&()".includes(char)) {
      if (word) { words.push(word); word = ""; }
      if (char === "\n" || ";|&()".includes(char)) {
        if (words.length) segments.push(words);
        words = [];
      }
      continue;
    }
    word += char;
  }
  if (word) words.push(word);
  if (words.length) segments.push(words);
  return segments;
}

function basename(value) {
  return String(value || "").replaceAll("\\", "/").split("/").at(-1);
}

function commandUsesHeavyExecutable(command, names, depth = 0) {
  if (depth > 2) return false;
  for (const segment of shellWords(command)) {
    let cursor = 0;
    while (["env", "command", "sudo", "time", "nice", "nohup"].includes(basename(segment[cursor]))) cursor++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[cursor] || "")) cursor++;
    if (basename(segment[cursor]) === "timeout") {
      cursor++;
      while (segment[cursor]?.startsWith("-")) cursor++;
      if (segment[cursor]) cursor++;
    }
    const executable = basename(segment[cursor]);
    if (names.has(executable)) return true;
    if (["sh", "bash"].includes(executable)) {
      const rest = segment.slice(cursor + 1);
      if (rest.some((item) => /^-.*c$/.test(item))) {
        const script = rest.at(-1) || "";
        if (commandUsesHeavyExecutable(script, names, depth + 1)) return true;
      } else if (names.has(basename(rest.at(-1)))) return true;
    }
  }
  return false;
}

export function evaluateCodexVerificationTool(repoRoot, payload) {
  if (payload?.tool_name !== "Bash") return { allowed: true };
  const config = readCodexVerificationConfig(repoRoot);
  if (!config.valid) return { allowed: false, reason: config.reason };
  const policy = config.policy;
  if (!policy || policy.mode !== "CI_FIRST") {
    return { allowed: true };
  }
  const command = payload?.tool_input?.command;
  if (typeof command !== "string") return { allowed: false, reason: "VERIFICATION_COMMAND_MISSING" };
  const names = new Set(policy.heavyLocalCommands);
  if (commandUsesHeavyExecutable(command, names)) {
    return { allowed: false, reason: "CI_FIRST_LOCAL_HEAVY_COMMAND_DENIED" };
  }
  return { allowed: true };
}
