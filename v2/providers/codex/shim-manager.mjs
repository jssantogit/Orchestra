import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { renderCodexV2Shim } from "./shim-template.mjs";

const SHIM_RELATIVE_PATH = ".codex/orchestra-v2-hook.mjs";
const HOOKS_RELATIVE_PATH = ".codex/hooks.json";

function shellQuotePosix(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellQuotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function makeHookEntry(eventName, command, commandWindows) {
  const hook = {
    type: "command",
    command,
    commandWindows,
    timeout: 10,
    statusMessage: "Checking Orchestra v2 global authority",
  };
  return {
    matcher: eventName === "SessionStart" ? "startup|resume|clear|compact" : ".*",
    hooks: [hook],
  };
}

function hasCommand(entries, command, commandWindows) {
  return entries.some((entry) => Array.isArray(entry?.hooks)
    && entry.hooks.some((hook) => hook?.command === command && hook?.commandWindows === commandWindows));
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot));
}

function resolveGlobalFile(path, label, projectRoot) {
  let canonical;
  try {
    canonical = realpathSync(path);
  } catch {
    const error = new Error(`${label} must resolve to an existing global file.`);
    error.code = "CODEX_V2_GLOBAL_LAUNCHER_INVALID";
    throw error;
  }
  if (!statSync(canonical).isFile()) {
    const error = new Error(`${label} must be a file.`);
    error.code = "CODEX_V2_GLOBAL_LAUNCHER_INVALID";
    throw error;
  }
  if (isWithin(projectRoot, canonical)) {
    const error = new Error(`${label} cannot resolve inside the project workspace.`);
    error.code = "CODEX_V2_GLOBAL_LAUNCHER_PROJECT_LOCAL";
    throw error;
  }
  return canonical;
}

function isLegacyV1AuthorityHook(hook) {
  const command = `${hook?.command ?? ""}\n${hook?.commandWindows ?? ""}`
    .replaceAll("\\", "/")
    .toLowerCase();
  return command.includes(".codex/astra-orchestra/session-hook.mjs")
    || command.includes(".codex/astra-orchestra/session-post-tool-hook.mjs");
}

function removeLegacyV1AuthorityHooks(config) {
  for (const [eventName, entries] of Object.entries(config.hooks)) {
    if (!Array.isArray(entries)) continue;
    config.hooks[eventName] = entries
      .map((entry) => ({
        ...entry,
        hooks: Array.isArray(entry?.hooks) ? entry.hooks.filter((hook) => !isLegacyV1AuthorityHook(hook)) : entry?.hooks,
      }))
      .filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length > 0);
  }
}

export function buildCodexV2ShimArtifacts({
  launcherPath,
  nodePath = process.execPath,
  orchestraHome = null,
  shimPath = SHIM_RELATIVE_PATH,
} = {}) {
  if (typeof launcherPath !== "string" || launcherPath.trim() === "") {
    throw new TypeError("launcherPath is required");
  }
  if (typeof nodePath !== "string" || nodePath.trim() === "") {
    throw new TypeError("nodePath is required");
  }
  if (typeof shimPath !== "string" || shimPath.trim() === "") {
    throw new TypeError("shimPath is required");
  }
  if (orchestraHome !== null && (typeof orchestraHome !== "string" || orchestraHome.trim() === "")) {
    throw new TypeError("orchestraHome must be a non-empty path when provided");
  }

  const command = `${shellQuotePosix(nodePath)} ${shellQuotePosix(shimPath)}`;
  const commandWindows = `& ${shellQuotePowerShell(nodePath)} ${shellQuotePowerShell(shimPath)}`;
  const hooks = {};
  for (const eventName of ["SessionStart", "PreToolUse", "PostToolUse"]) {
    hooks[eventName] = [makeHookEntry(eventName, command, commandWindows)];
  }

  return Object.freeze({
    shimSource: renderCodexV2Shim({ launcherPath, nodePath, orchestraHome }),
    hooksJson: `${JSON.stringify({
      description: "Orchestra v2 thin Codex transport shim.",
      hooks,
    }, null, 2)}\n`,
    command,
    commandWindows,
  });
}

function readHooksConfig(path) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { description: "Orchestra v2 thin Codex transport shim.", hooks: {} };
    throw error;
  }

  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    const wrapped = new Error("Existing Codex hooks config is malformed; refusing to replace it.");
    wrapped.code = "CODEX_V2_HOOKS_CONFIG_INVALID";
    wrapped.cause = error;
    throw wrapped;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    const error = new Error("Existing Codex hooks config must be a JSON object.");
    error.code = "CODEX_V2_HOOKS_CONFIG_INVALID";
    throw error;
  }
  if (config.hooks === undefined) config.hooks = {};
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    const error = new Error("Existing Codex hooks config must contain a hooks object.");
    error.code = "CODEX_V2_HOOKS_CONFIG_INVALID";
    throw error;
  }
  return config;
}

export function installCodexV2Shim({ targetDir, launcherPath, nodePath = process.execPath, orchestraHome = null } = {}) {
  if (typeof targetDir !== "string" || targetDir.trim() === "") {
    throw new TypeError("targetDir is required");
  }
  if (typeof launcherPath !== "string" || launcherPath.trim() === "") {
    throw new TypeError("launcherPath is required");
  }
  if (!isAbsolute(targetDir)) throw new TypeError("targetDir must be absolute");
  if (!isAbsolute(launcherPath)) throw new TypeError("launcherPath must be absolute");
  if (!isAbsolute(nodePath)) throw new TypeError("nodePath must be absolute");

  const root = resolve(targetDir);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    throw new TypeError("targetDir must exist before installing the Codex v2 shim");
  }
  const globalLauncherPath = resolveGlobalFile(launcherPath, "launcherPath", canonicalRoot);
  const globalNodePath = resolveGlobalFile(nodePath, "nodePath", canonicalRoot);
  const globalOrchestraHome = orchestraHome === null ? null : resolve(orchestraHome);
  const codexDir = join(root, ".codex");
  const shimPath = join(root, SHIM_RELATIVE_PATH);
  const hooksPath = join(root, HOOKS_RELATIVE_PATH);
  const artifacts = buildCodexV2ShimArtifacts({
    launcherPath: globalLauncherPath,
    nodePath: globalNodePath,
    orchestraHome: globalOrchestraHome,
    shimPath,
  });
  const config = readHooksConfig(hooksPath);
  removeLegacyV1AuthorityHooks(config);

  for (const [eventName, entry] of Object.entries(JSON.parse(artifacts.hooksJson).hooks)) {
    const entries = config.hooks[eventName] ?? [];
    if (!Array.isArray(entries)) {
      const error = new Error(`Existing Codex hook event ${eventName} must be an array.`);
      error.code = "CODEX_V2_HOOKS_CONFIG_INVALID";
      throw error;
    }
    if (!hasCommand(entries, artifacts.command, artifacts.commandWindows)) {
      config.hooks[eventName] = [...entries, ...entry];
    }
  }

  mkdirSync(codexDir, { recursive: true });
  writeFileSync(shimPath, artifacts.shimSource, { encoding: "utf8", mode: 0o700 });
  writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return Object.freeze({
    ok: true,
    projectRoot: root,
    files: Object.freeze([HOOKS_RELATIVE_PATH, SHIM_RELATIVE_PATH]),
    launcherPath: globalLauncherPath,
  });
}
