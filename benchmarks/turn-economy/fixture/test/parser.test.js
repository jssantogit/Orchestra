import test from "node:test";
import assert from "node:assert/strict";
import { validateNumericInput, parseNumber, parsePercentage } from "../src/parser.js";

test("parser: validates and parses finite numbers", () => {
  assert.equal(validateNumericInput(42), 42);
  assert.equal(validateNumericInput("123.45"), 123.45);
  assert.equal(validateNumericInput("-10"), -10);
  assert.equal(parseNumber("3.14"), 3.14);
});

test("parser: rejects non-numeric types", () => {
  assert.throws(() => validateNumericInput(null), TypeError);
  assert.throws(() => validateNumericInput(undefined), TypeError);
  assert.throws(() => validateNumericInput(true), TypeError);
  assert.throws(() => validateNumericInput({}), TypeError);
  assert.throws(() => validateNumericInput([]), TypeError);
});

test("parser: rejects invalid numeric values", () => {
  assert.throws(() => validateNumericInput(NaN), RangeError);
  assert.throws(() => validateNumericInput(Infinity), RangeError);
  assert.throws(() => validateNumericInput(-Infinity), RangeError);
  assert.throws(() => validateNumericInput(""), RangeError);
  assert.throws(() => validateNumericInput("   "), RangeError);
  assert.throws(() => validateNumericInput("abc"), RangeError);
  assert.throws(() => validateNumericInput("12a4"), RangeError);
});

test("parser: enforces min and max constraints", () => {
  assert.throws(() => validateNumericInput(5, { min: 10 }), RangeError);
  assert.throws(() => validateNumericInput(15, { max: 10 }), RangeError);
  assert.equal(validateNumericInput(10, { min: 10, max: 20 }), 10);
});

test("parser: parses valid percentage strings", () => {
  assert.equal(parsePercentage("50%"), 0.5);
  assert.equal(parsePercentage("100%"), 1.0);
  assert.equal(parsePercentage("0%"), 0.0);
});
