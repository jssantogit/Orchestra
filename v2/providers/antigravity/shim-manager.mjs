import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { renderAntigravityV2Shim } from "./shim-template.mjs";

const SHIM_RELATIVE_PATH = ".agents/orchestra-v2-hook.mjs";
const HOOKS_RELATIVE_PATH = ".agents/hooks.json";
const HOOK_GROUP = "orchestra-v2-global";
const HOOK_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse"];

function shimError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function shellQuotePosix(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function shellQuotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
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
    throw shimError("ANTIGRAVITY_V2_GLOBAL_LAUNCHER_INVALID", `${label} must resolve to an existing global file.`);
  }
  if (!statSync(canonical).isFile()) {
    throw shimError("ANTIGRAVITY_V2_GLOBAL_LAUNCHER_INVALID", `${label} must be a file.`);
  }
  if (isWithin(projectRoot, canonical)) {
    throw shimError("ANTIGRAVITY_V2_GLOBAL_LAUNCHER_PROJECT_LOCAL", `${label} cannot resolve inside the Project workspace.`);
  }
  return canonical;
}

function makeHookEntry(eventName, command, commandWindows) {
  const hook = {
    type: "command",
    command,
    commandWindows,
    timeout: 10,
  };
  return {
    ...(eventName === "PreToolUse" || eventName === "PostToolUse" ? { matcher: "*" } : {}),
    hooks: [hook],
  };
}

function hasHook(entries, command, commandWindows) {
  return entries.some((entry) => Array.isArray(entry?.hooks)
    && entry.hooks.some((hook) => hook?.command === command && hook?.commandWindows === commandWindows));
}

function readHooksConfig(path) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    const wrapped = shimError("ANTIGRAVITY_V2_HOOKS_CONFIG_INVALID", "Existing Antigravity hooks config is malformed; refusing to replace it.");
    wrapped.cause = error;
    throw wrapped;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw shimError("ANTIGRAVITY_V2_HOOKS_CONFIG_INVALID", "Existing Antigravity hooks config must be an object.");
  }
  return config;
}

export function buildAntigravityV2ShimArtifacts({
  launcherPath,
  nodePath = process.execPath,
  orchestraHome = null,
  shimPath = SHIM_RELATIVE_PATH,
} = {}) {
  if (typeof launcherPath !== "string" || launcherPath.trim() === "") throw new TypeError("launcherPath is required");
  if (typeof nodePath !== "string" || nodePath.trim() === "") throw new TypeError("nodePath is required");
  if (typeof shimPath !== "string" || shimPath.trim() === "") throw new TypeError("shimPath is required");
  if (orchestraHome !== null && (typeof orchestraHome !== "string" || orchestraHome.trim() === "")) {
    throw new TypeError("orchestraHome must be a non-empty path when provided");
  }

  const command = `${shellQuotePosix(nodePath)} ${shellQuotePosix(shimPath)}`;
  const commandWindows = `& ${shellQuotePowerShell(nodePath)} ${shellQuotePowerShell(shimPath)}`;
  const hooks = Object.fromEntries(HOOK_EVENTS.map((eventName) => [
    eventName,
    [makeHookEntry(eventName, command, commandWindows)],
  ]));
  return Object.freeze({
    shimSource: renderAntigravityV2Shim({ launcherPath, nodePath, orchestraHome }),
    hooksJson: `${JSON.stringify({ [HOOK_GROUP]: hooks }, null, 2)}\n`,
    command,
    commandWindows,
  });
}

export async function installAntigravityV2Shim({
  registry,
  projectId,
  targetDir,
  launcherPath,
  nodePath = process.execPath,
} = {}) {
  if (!registry || typeof registry.resolveWorkspace !== "function" || typeof registry.paths?.home !== "string") {
    throw new TypeError("global project registry is required");
  }
  if (typeof projectId !== "string" || projectId.trim() === "") throw new TypeError("projectId is required");
  if (typeof targetDir !== "string" || targetDir.trim() === "" || !isAbsolute(targetDir)) {
    throw new TypeError("targetDir must be an absolute registered Project root");
  }
  if (typeof launcherPath !== "string" || launcherPath.trim() === "" || !isAbsolute(launcherPath)) {
    throw new TypeError("launcherPath must be absolute");
  }
  if (typeof nodePath !== "string" || nodePath.trim() === "" || !isAbsolute(nodePath)) {
    throw new TypeError("nodePath must be absolute");
  }

  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(resolve(targetDir));
  } catch {
    throw new TypeError("targetDir must exist before installing the Antigravity v2 shim");
  }
  const project = await registry.resolveWorkspace(canonicalRoot);
  if (!project || project.projectId !== projectId || project.workspace?.canonicalRoot !== canonicalRoot) {
    throw shimError("ANTIGRAVITY_V2_PROJECT_NOT_REGISTERED", "Antigravity v2 shim installation requires the exact globally registered Project root and ID.");
  }

  const globalLauncherPath = resolveGlobalFile(launcherPath, "launcherPath", canonicalRoot);
  const globalNodePath = resolveGlobalFile(nodePath, "nodePath", canonicalRoot);
  const hooksPath = join(canonicalRoot, HOOKS_RELATIVE_PATH);
  const shimPath = join(canonicalRoot, SHIM_RELATIVE_PATH);
  const artifacts = buildAntigravityV2ShimArtifacts({
    launcherPath: globalLauncherPath,
    nodePath: globalNodePath,
    orchestraHome: registry.paths.home,
    shimPath,
  });
  const config = readHooksConfig(hooksPath);
  let group = config[HOOK_GROUP];
  if (group === undefined) group = {};
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    throw shimError("ANTIGRAVITY_V2_HOOKS_CONFIG_INVALID", `Existing ${HOOK_GROUP} hooks must be an object.`);
  }
  const generatedHooks = JSON.parse(artifacts.hooksJson)[HOOK_GROUP];
  for (const [eventName, generatedEntries] of Object.entries(generatedHooks)) {
    const entries = group[eventName] ?? [];
    if (!Array.isArray(entries)) {
      throw shimError("ANTIGRAVITY_V2_HOOKS_CONFIG_INVALID", `Existing Antigravity ${eventName} hooks must be an array.`);
    }
    if (!hasHook(entries, artifacts.command, artifacts.commandWindows)) {
      group[eventName] = [...entries, ...generatedEntries];
    } else {
      group[eventName] = entries;
    }
  }
  config[HOOK_GROUP] = group;

  mkdirSync(join(canonicalRoot, ".agents"), { recursive: true });
  writeFileSync(shimPath, artifacts.shimSource, { encoding: "utf8", mode: 0o700 });
  writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return Object.freeze({
    ok: true,
    projectId,
    projectRoot: canonicalRoot,
    files: Object.freeze([HOOKS_RELATIVE_PATH, SHIM_RELATIVE_PATH]),
    launcherPath: globalLauncherPath,
  });
}
