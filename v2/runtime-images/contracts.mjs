const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]) return false;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function validateRuntimeImageRecord(image) {
  if (!isRecord(image)) return { valid: false, reason: "IMAGE_RECORD_INVALID" };
  if (image.schema !== "orchestra.runtime-image.v2") return { valid: false, reason: "IMAGE_SCHEMA_INVALID" };
  if (typeof image.imageId !== "string" || !DIGEST_RE.test(image.imageId)) {
    return { valid: false, reason: "IMAGE_ID_INVALID" };
  }
  if (typeof image.version !== "string" || !SEMVER_RE.test(image.version)) {
    return { valid: false, reason: "IMAGE_VERSION_INVALID" };
  }
  if (typeof image.manifestDigest !== "string" || !DIGEST_RE.test(image.manifestDigest)) {
    return { valid: false, reason: "IMAGE_MANIFEST_DIGEST_INVALID" };
  }
  if (image.imageId !== image.manifestDigest) return { valid: false, reason: "IMAGE_ID_NOT_CONTENT_DERIVED" };
  if (image.manifestRef !== `blob:${image.manifestDigest}`) {
    return { valid: false, reason: "IMAGE_MANIFEST_REF_INVALID" };
  }
  if (!isRecord(image.engineCompatibility)) return { valid: false, reason: "IMAGE_ENGINE_COMPATIBILITY_INVALID" };
  if (!isRecord(image.providerAdapterCompatibility)) {
    return { valid: false, reason: "IMAGE_PROVIDER_ADAPTER_COMPATIBILITY_INVALID" };
  }
  for (const provider of ["codex", "antigravity"]) {
    if (!isRecord(image.providerAdapterCompatibility[provider])) {
      return { valid: false, reason: `IMAGE_${provider.toUpperCase()}_COMPATIBILITY_INVALID` };
    }
  }
  if (!validTimestamp(image.createdAt)) return { valid: false, reason: "IMAGE_CREATED_AT_INVALID" };
  return { valid: true };
}
