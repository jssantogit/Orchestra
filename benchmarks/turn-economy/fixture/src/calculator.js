import { parseNumber } from "./parser.js";
import { formatNumber } from "./formatter.js";

/**
 * Basic calculator module providing core arithmetic operations.
 */

export function add(a, b) {
  const numA = parseNumber(a);
  const numB = parseNumber(b);
  return numA + numB;
}

export function subtract(a, b) {
  const numA = parseNumber(a);
  const numB = parseNumber(b);
  return numA - numB;
}

export function multiply(a, b) {
  const numA = parseNumber(a);
  const numB = parseNumber(b);
  return numA * numB;
}

export function divide(a, b) {
  const numA = parseNumber(a);
  const numB = parseNumber(b);
  if (numB === 0) {
    throw new RangeError("Division by zero");
  }
  return numA / numB;
}

/**
 * Formats the result of an arithmetic operation.
 */
export function calculateAndFormat(op, a, b, options = {}) {
  let res;
  switch (op) {
    case "add":
      res = add(a, b);
      break;
    case "subtract":
      res = subtract(a, b);
      break;
    case "multiply":
      res = multiply(a, b);
      break;
    case "divide":
      res = divide(a, b);
      break;
    default:
      throw new Error(`Unsupported operation: ${op}`);
  }
  return formatNumber(res, options);
}
