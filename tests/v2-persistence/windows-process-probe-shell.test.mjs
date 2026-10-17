import test from "node:test";
import assert from "node:assert/strict";

import { createHostProcessIdentityReader } from "../../v2/liveness/local-process-probe.mjs";

test("Windows identity reader prefers pwsh and does not invoke legacy PowerShell when pwsh succeeds", async () => {
  const calls = [];
  const reader = createHostProcessIdentityReader({
    platform: "win32",
    execFileImpl: async (executable) => {
      calls.push(executable);
      return { stdout: "PRESENT:123456\r\n" };
    },
  });

  assert.deepEqual(await reader(42), {
    status: "PRESENT",
    processIdentity: "windows:123456",
  });
  assert.deepEqual(calls, ["pwsh.exe"]);
});

test("Windows identity reader falls back to legacy PowerShell only when pwsh is absent", async () => {
  const calls = [];
  const reader = createHostProcessIdentityReader({
    platform: "win32",
    execFileImpl: async (executable) => {
      calls.push(executable);
      if (executable === "pwsh.exe") {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
      return { stdout: "PRESENT:789\r\n" };
    },
  });

  assert.deepEqual(await reader(42), {
    status: "PRESENT",
    processIdentity: "windows:789",
  });
  assert.deepEqual(calls, ["pwsh.exe", "powershell.exe"]);
});

test("Windows identity reader does not reinterpret a pwsh timeout through a second shell", async () => {
  const calls = [];
  const reader = createHostProcessIdentityReader({
    platform: "win32",
    execFileImpl: async (executable) => {
      calls.push(executable);
      const error = new Error("timed out");
      error.code = "ETIMEDOUT";
      throw error;
    },
  });

  assert.deepEqual(await reader(42), { status: "UNAVAILABLE" });
  assert.deepEqual(calls, ["pwsh.exe"]);
});
