import test from "node:test";
import assert from "node:assert/strict";
import { readDelegatedProcessGroupStatus } from "../../runtime/delegation/v2-process-group-probe.mjs";

test("POSIX group probe addresses the negative process-group ID, not the direct child PID", () => {
  const seen = [];
  const state = readDelegatedProcessGroupStatus(19876, {
    platform: "linux",
    kill(pid, signal) { seen.push([pid, signal]); },
  });
  assert.equal(state, "PRESENT");
  assert.deepEqual(seen, [[-19876, 0]]);
});

test("process-group disappearance is observable but not proof of escaped descendant exit", () => {
  const absent = readDelegatedProcessGroupStatus(9876, {
    platform: "linux",
    kill() { const error = new Error("not found"); error.code = "ESRCH"; throw error; },
  });
  assert.equal(absent, "ABSENT");
});

test("inaccessible or inconclusive groups fail closed as live or unknown", () => {
  const forbidden = readDelegatedProcessGroupStatus(9876, {
    platform: "linux",
    kill() { const error = new Error("permission"); error.code = "EPERM"; throw error; },
  });
  const other = readDelegatedProcessGroupStatus(9876, {
    platform: "linux",
    kill() { throw new Error("unknown"); },
  });
  assert.equal(forbidden, "PRESENT");
  assert.equal(other, "UNAVAILABLE");
  assert.equal(readDelegatedProcessGroupStatus(9876, { platform: "win32" }), "UNAVAILABLE");
  assert.equal(readDelegatedProcessGroupStatus(-1, { platform: "linux" }), "UNAVAILABLE");
});
