const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VALID_BUMPS = new Set(["patch", "minor", "major"]);

export function parseStableVersion(version) {
  const match = STABLE_SEMVER.exec(String(version || ""));
  if (!match) throw new Error(`Expected stable semantic version, got: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function bumpVersion(version, bump) {
  if (!VALID_BUMPS.has(bump)) throw new Error("Release bump must be patch, minor, or major");
  const current = parseStableVersion(version);
  if (bump === "major") return `${current.major + 1}.0.0`;
  if (bump === "minor") return `${current.major}.${current.minor + 1}.0`;
  return `${current.major}.${current.minor}.${current.patch + 1}`;
}

function commitRank(commit = {}) {
  const subject = String(commit.subject || "");
  const body = String(commit.body || "");
  if (/^[a-zA-Z][\w-]*(?:\([^)]*\))?!:/.test(subject) || /(^|\n)BREAKING CHANGE:/m.test(body)) return 3;
  if (/^feat(?:\([^)]*\))?:/.test(subject)) return 2;
  if (/^(?:fix|perf)(?:\([^)]*\))?:/.test(subject)) return 1;
  return 0;
}

export function suggestBump(commits = []) {
  const maxRank = commits.reduce((max, commit) => Math.max(max, commitRank(commit)), 0);
  return [null, "patch", "minor", "major"][maxRank];
}
