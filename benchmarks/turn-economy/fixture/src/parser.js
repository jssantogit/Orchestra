/**
 * Input validation and parsing module.
 */

/**
 * Validates whether the given value is acceptable numeric input.
 * Rejects:
 * 1. Non-number and non-string types (null, undefined, boolean, object, array).
 * 2. NaN values.
 * 3. Infinite values (+Infinity and -Infinity).
 * 4. Empty or whitespace-only strings.
 * 5. Malformed numeric strings containing alphabetic or symbol characters.
 * 6. Values outside specified range [options.min, options.max].
 *
 * @param {unknown} value - Value to validate.
 * @param {object} [options] - Validation options.
 * @param {number} [options.min] - Minimum permissible value.
 * @param {number} [options.max] - Maximum permissible value.
 * @returns {number} The validated finite numeric value.
 */
export function validateNumericInput(value, options = {}) {
  if (value === null || value === undefined) {
    throw new TypeError("Value cannot be null or undefined");
  }

  if (typeof value !== "number" && typeof value !== "string") {
    throw new TypeError(`Expected number or string, received ${typeof value}`);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new RangeError("Input string is empty");
    }
    // Strict numeric pattern check: optional sign, digits, optional decimal dot and digits
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
      throw new RangeError(`String "${value}" cannot be parsed as a valid number`);
    }
  }

  const num = Number(value);

  if (Number.isNaN(num)) {
    throw new RangeError("Value cannot be NaN");
  }

  if (!Number.isFinite(num)) {
    throw new RangeError("Value must be finite");
  }

  if (options.min !== undefined && num < options.min) {
    throw new RangeError(`Value ${num} is below minimum allowed ${options.min}`);
  }

  if (options.max !== undefined && num > options.max) {
    throw new RangeError(`Value ${num} exceeds maximum allowed ${options.max}`);
  }

  return num;
}

/**
 * Parses and validates an input into a number.
 *
 * @param {unknown} input - Raw input to parse.
 * @param {object} [options] - Parsing options.
 * @returns {number} Parsed float number.
 */
export function parseNumber(input, options = {}) {
  return validateNumericInput(input, options);
}

/**
 * Parses a percentage string (e.g., "45%") into a decimal fraction (0.45).
 *
 * @param {string} input - Percentage string.
 * @returns {number} Decimal fraction.
 */
export function parsePercentage(input) {
  if (typeof input !== "string") {
    throw new TypeError("Percentage input must be a string");
  }

  const trimmed = input.trim();
  const match = trimmed.match(/^([0-9]+)%$/);
  if (!match) {
    throw new RangeError(`Invalid percentage format: "${input}"`);
  }

  return Number(match[1]) / 100;
}
