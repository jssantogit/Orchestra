import { validateRuntimeImageRecord } from "./contracts.mjs";

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAJOR_WILDCARD_RE = /^(0|[1-9]\d*)\.x$/;
const PROVIDERS = new Set(["codex", "antigravity"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER_RE.exec(value);
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part))
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function compareSemver(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function parseRange(range) {
  if (!isRecord(range)) return null;
  const keys = Object.keys(range).sort();
  if (keys.length !== 2 || keys[0] !== "max" || keys[1] !== "min") return null;
  const min = parseSemver(range.min);
  if (!min) return null;

  const wildcard = typeof range.max === "string" ? MAJOR_WILDCARD_RE.exec(range.max) : null;
  if (wildcard) {
    const upperExclusive = { major: Number(wildcard[1]) + 1, minor: 0, patch: 0, prerelease: [] };
    if (compareSemver(min, upperExclusive) >= 0) return null;
    return { min, upperExclusive, max: null };
  }

  const max = parseSemver(range.max);
  if (!max || compareSemver(min, max) > 0) return null;
  return { min, max, upperExclusive: null };
}

function inRange(version, range) {
  if (compareSemver(version, range.min) < 0) return false;
  if (range.upperExclusive) return compareSemver(version, range.upperExclusive) < 0;
  return compareSemver(version, range.max) <= 0;
}

function invalid(imageId, field = null) {
  return {
    ok: false,
    code: "RUNTIME_IMAGE_COMPATIBILITY_INVALID",
    imageId: typeof imageId === "string" ? imageId : null,
    ...(field ? { field } : {}),
  };
}

export function assessRuntimeImageCompatibility({
  image,
  engineVersion,
  provider,
  providerAdapterVersion,
} = {}) {
  const recordValidation = validateRuntimeImageRecord(image);
  if (!recordValidation.valid) return invalid(image?.imageId, "image");
  if (!PROVIDERS.has(provider)) return invalid(image.imageId, "provider");

  const engine = parseSemver(engineVersion);
  if (!engine) return invalid(image.imageId, "engineVersion");
  const adapter = parseSemver(providerAdapterVersion);
  if (!adapter) return invalid(image.imageId, "providerAdapterVersion");

  const engineRange = parseRange(image.engineCompatibility);
  if (!engineRange) return invalid(image.imageId, "engineCompatibility");
  const providerRange = parseRange(image.providerAdapterCompatibility?.[provider]);
  if (!providerRange) return invalid(image.imageId, `providerAdapterCompatibility.${provider}`);

  if (!inRange(engine, engineRange)) {
    return {
      ok: false,
      code: "ENGINE_VERSION_INCOMPATIBLE",
      imageId: image.imageId,
      actualVersion: engineVersion,
      required: { ...image.engineCompatibility },
    };
  }

  if (!inRange(adapter, providerRange)) {
    return {
      ok: false,
      code: "PROVIDER_ADAPTER_VERSION_INCOMPATIBLE",
      imageId: image.imageId,
      provider,
      actualVersion: providerAdapterVersion,
      required: { ...image.providerAdapterCompatibility[provider] },
    };
  }

  return {
    ok: true,
    code: "RUNTIME_IMAGE_COMPATIBLE",
    imageId: image.imageId,
    provider,
  };
}
