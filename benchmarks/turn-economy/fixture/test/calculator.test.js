import test from "node:test";
import assert from "node:assert/strict";
import { add, subtract, multiply, divide, calculateAndFormat } from "../src/calculator.js";

test("calculator: basic arithmetic operations", () => {
  assert.equal(add(10, 20), 30);
  assert.equal(subtract(50, 15), 35);
  assert.equal(multiply(6, 7), 42);
  assert.equal(divide(100, 4), 25);
});

test("calculator: handles string numeric inputs", () => {
  assert.equal(add("15", "25"), 40);
  assert.equal(multiply("3", "9"), 27);
});

test("calculator: throws on division by zero", () => {
  assert.throws(() => divide(10, 0), /Division by zero/);
});

test("calculator: calculateAndFormat outputs formatted string", () => {
  const result = calculateAndFormat("add", 100, 50, { prefix: "$" });
  assert.equal(result, "$150");
});
