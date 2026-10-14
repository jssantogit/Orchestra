import test from "node:test";
import assert from "node:assert/strict";

import { runBoundedProcess } from "../../runtime/delegation/process-runner.mjs";

test("explicit subprocess environment does not inherit undeclared parent secrets", async (t) => {
  const secretKey = `ORCHESTRA_PARENT_SECRET_${process.pid}`;
  const previous = process.env[secretKey];
  process.env[secretKey] = "top-secret";
  t.after(() => {
    if (previous === undefined) delete process.env[secretKey];
    else process.env[secretKey] = previous;
  });

  const script = [
    `const key=${JSON.stringify(secretKey)};`,
    "process.stdout.write(JSON.stringify({",
    "explicit: process.env.ORCHESTRA_TEST_VALUE ?? null,",
    "inherited: process.env[key] ?? null,",
    "pathPresent: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,",
    "}));",
  ].join(" ");

  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["-e", script],
    timeoutMs: 2000,
    maxOutputBytes: 2048,
    env: {
      PATH: process.env.PATH ?? "",
      ORCHESTRA_TEST_VALUE: "ok",
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    explicit: "ok",
    inherited: null,
    pathPresent: true,
  });
});
