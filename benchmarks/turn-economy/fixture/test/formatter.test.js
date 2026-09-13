import test from "node:test";
import assert from "node:assert/strict";
import { formatNumber, formatPercentage } from "../src/formatter.js";

test("formatter: formats positive numbers", () => {
  assert.equal(formatNumber(42), "42");
  assert.equal(formatNumber(1234.5), "1234.5");
});

test("formatter: handles prefix and suffix options", () => {
  assert.equal(formatNumber(99, { prefix: "$" }), "$99");
  assert.equal(formatNumber(100, { suffix: " USD" }), "100 USD");
});

test("formatter: formats percentages", () => {
  assert.equal(formatPercentage(0.45), "45%");
  assert.equal(formatPercentage(1.0), "100%");
});

test("formatter: rejects non-numeric input", () => {
  assert.throws(() => formatNumber("not-a-number"), TypeError);
  assert.throws(() => formatNumber(NaN), TypeError);
});
