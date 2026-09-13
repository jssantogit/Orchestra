# Turn Economy Benchmark Fixture

A lightweight, provider-neutral calculator and parsing library used as a repeatable synthetic benchmark fixture for Orchestra turn economy evaluations.

## Structure

- `src/calculator.js` — Arithmetic operations and higher-level calculations.
- `src/parser.js` — Numeric input validation and parsing.
- `src/formatter.js` — Formatting functions for numbers and percentages.
- `test/*.test.js` — Deterministic test suite run with `node --test`.

## Running Tests

```bash
node --test test/*.test.js
```
