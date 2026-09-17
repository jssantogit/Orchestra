import { createHash } from "node:crypto";

function isPlainObject(val) {
  if (typeof val !== "object" || val === null) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/**
 * Deterministically serializes a JavaScript value to canonical JSON:
 * - UTF-8 representation
 * - Lexicographically sorted object keys (recursive)
 * - Array order preserved by default
 * - Arrays under keys in `setLikeKeys` sorted by their canonical element representation
 * - Rejects undefined, functions, symbols, bigint, NaN, and infinities
 * - Does not strip or alter keys inside values
 *
 * @param {unknown} value
 * @param {{ setLikeKeys?: Set<string> | Iterable<string> }} [options]
 * @returns {string}
 */
export function canonicalize(value, { setLikeKeys = new Set() } = {}) {
  const normalizedSetKeys = setLikeKeys instanceof Set ? setLikeKeys : new Set(setLikeKeys);

  function serialize(val, currentKey = null) {
    if (val === undefined) {
      throw new TypeError(`Cannot canonicalize undefined value${currentKey !== null ? ` at property "${currentKey}"` : ""}`);
    }
    if (typeof val === "function") {
      throw new TypeError(`Cannot canonicalize function${currentKey !== null ? ` at property "${currentKey}"` : ""}`);
    }
    if (typeof val === "symbol") {
      throw new TypeError(`Cannot canonicalize symbol${currentKey !== null ? ` at property "${currentKey}"` : ""}`);
    }
    if (typeof val === "bigint") {
      throw new TypeError(`Cannot canonicalize bigint${currentKey !== null ? ` at property "${currentKey}"` : ""}`);
    }
    if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        throw new TypeError(`Cannot canonicalize non-finite number: ${val}${currentKey !== null ? ` at property "${currentKey}"` : ""}`);
      }
      if (Object.is(val, -0)) return "0";
      return JSON.stringify(val);
    }
    if (typeof val === "boolean") {
      return val ? "true" : "false";
    }
    if (typeof val === "string") {
      return JSON.stringify(val);
    }
    if (val === null) {
      return "null";
    }
    if (Array.isArray(val)) {
      const elements = val.map((elem, idx) => serialize(elem, idx));
      if (currentKey !== null && normalizedSetKeys.has(String(currentKey))) {
        elements.sort();
      }
      return `[${elements.join(",")}]`;
    }
    if (isPlainObject(val)) {
      const keys = Object.keys(val).sort();
      const entries = [];
      for (const key of keys) {
        const propVal = val[key];
        const propStr = serialize(propVal, key);
        entries.push(`${JSON.stringify(key)}:${propStr}`);
      }
      return `{${entries.join(",")}}`;
    }
    throw new TypeError(`Cannot canonicalize unsupported object type${currentKey !== null ? ` at property "${currentKey}"` : ""}`);
  }

  return serialize(value, null);
}

/**
 * Computes SHA-256 over the canonical JSON representation of a value.
 *
 * @param {unknown} value
 * @param {{ setLikeKeys?: Set<string> | Iterable<string> }} [options]
 * @returns {string} Formatted as "sha256:<64-char-lowercase-hex>"
 */
export function sha256Canonical(value, options = {}) {
  const canonical = canonicalize(value, options);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${hash}`;
}
