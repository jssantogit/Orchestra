/**
 * Numeric formatting utilities.
 */

/**
 * Formats a numeric value into a display string.
 *
 * NOTE: There is an intentional known bug here where negative values lose their sign!
 *
 * @param {number} value - Number to format.
 * @param {object} [options] - Formatting options.
 * @param {string} [options.prefix=""] - Optional prefix (e.g. "$").
 * @param {string} [options.suffix=""] - Optional suffix (e.g. " USD").
 * @returns {string} Formatted string.
 */
export function formatNumber(value, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Value must be a finite number");
  }

  // BUG: uses Math.abs so negative values lose their sign
  const absVal = Math.abs(value);
  const prefix = options.prefix || "";
  const suffix = options.suffix || "";

  return `${prefix}${absVal}${suffix}`;
}

/**
 * Formats a decimal fraction as a percentage string.
 *
 * @param {number} value - Decimal value (e.g. 0.25).
 * @returns {string} Formatted percentage (e.g. "25%").
 */
export function formatPercentage(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Value must be a finite number");
  }

  const pct = Math.round(value * 100);
  return `${pct}%`;
}
