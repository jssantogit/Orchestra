import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const SOURCE_SCHEMA = "orchestra.runtime-image-source.v2";
const RUNTIME_VERSION = "2.0.0";
const COMPATIBILITY = Object.freeze({ min: RUNTIME_VERSION, max: "2.x" });

function sourceError(code, message, fields = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, fields);
  return error;
}

function git(repoRoot, args, options = {}) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: options.encoding,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw sourceError("ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_INVALID", "Git could not read the requested repository state");
  }
}

function repositoryRoot(repoRoot) {
  if (typeof repoRoot !== "string" || repoRoot.trim().length === 0) {
    throw new TypeError("repoRoot is required");
  }
  let requestedRoot;
  let relativeToGitRoot;
  try {
    requestedRoot = realpathSync(repoRoot);
    relativeToGitRoot = git(repoRoot, ["rev-parse", "--show-cdup"], { encoding: "utf8" }).trim();
  } catch (error) {
    if (error?.code === "ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_INVALID") throw error;
    throw sourceError("ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_INVALID", "repoRoot must be a readable Git working tree");
  }
  if (relativeToGitRoot.length > 0) {
    throw sourceError("ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_INVALID", "repoRoot must be the Git checkout root");
  }
  return requestedRoot;
}

function trackedV2Entries(repoRoot) {
  const output = git(repoRoot, ["ls-tree", "-rz", "--full-tree", "HEAD", "--", "v2"], { encoding: null });
  const entries = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) {
      throw sourceError("ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_ENTRY_INVALID", "Git returned an invalid v2 tree entry");
    }
    const [mode, type] = record.slice(0, separator).split(" ");
    const filePath = record.slice(separator + 1);
    if (type !== "blob" || !["100644", "100755"].includes(mode) || !filePath.startsWith("v2/")) {
      throw sourceError(
        "ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_ENTRY_INVALID",
        "The tracked v2 source tree contains a non-regular file",
        { filePath },
      );
    }
    entries.push(filePath);
  }
  if (entries.length === 0) {
    throw sourceError("ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_INVALID", "The exact Git revision contains no tracked v2 files");
  }
  return entries.sort();
}

export function buildRuntimeImageSourceFromGit({ repoRoot, expectedHeadSha } = {}) {
  const root = repositoryRoot(repoRoot);
  if (typeof expectedHeadSha !== "string" || !/^[0-9a-f]{40}$/.test(expectedHeadSha)) {
    throw new TypeError("expectedHeadSha must be a full lowercase Git SHA");
  }
  const headSha = git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (headSha !== expectedHeadSha) {
    throw sourceError(
      "ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_HEAD_MISMATCH",
      "The checked-out Git revision does not match expectedHeadSha",
      { expectedHeadSha, actualHeadSha: headSha },
    );
  }

  const paths = trackedV2Entries(root);
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  if (status.length > 0) {
    throw sourceError(
      "ORCHESTRA_RUNTIME_IMAGE_SOURCE_GIT_DIRTY",
      "The Git checkout has tracked changes or untracked files",
    );
  }

  const files = paths.map((filePath) => {
    const content = git(root, ["show", `${headSha}:${filePath}`], { encoding: null });
    return { path: filePath, contentBase64: content.toString("base64") };
  });
  files.push({
    path: "candidate-head.json",
    contentBase64: Buffer.from(JSON.stringify({ headSha }), "utf8").toString("base64"),
  });
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  return Object.freeze({
    schema: SOURCE_SCHEMA,
    version: RUNTIME_VERSION,
    engineCompatibility: COMPATIBILITY,
    providerAdapterCompatibility: Object.freeze({ codex: COMPATIBILITY, antigravity: COMPATIBILITY }),
    files: Object.freeze(files),
  });
}
