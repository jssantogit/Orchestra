import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function readRecord(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function fileAgeMs(path) {
  try { return Math.max(0, Date.now() - statSync(path).mtimeMs); } catch { return Infinity; }
}

function writeNewLock(path, ownerIdHash) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o600);
  const record = {
    schema: "orchestra.atomic-lock.v1",
    pid: process.pid,
    ownerIdHash,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
  closeSync(fd);
  return { path, pid: process.pid, ownerIdHash };
}

function reclaimable(path, staleAfterMs) {
  const record = readRecord(path);
  const ageMs = fileAgeMs(path);
  if (!record) {
    return ageMs > staleAfterMs
      ? { yes: true, reason: "LOCK_MALFORMED_STALE" }
      : { yes: false, reason: "LOCK_MALFORMED_FRESH" };
  }
  if (pidAlive(record.pid)) return { yes: false, reason: "LOCK_ACTIVE" };
  return { yes: true, reason: "LOCK_OWNER_DEAD" };
}

export function acquireAtomicLock(lockPath, { ownerIdHash, staleAfterMs = 30_000 } = {}) {
  if (!ownerIdHash) return { acquired: false, handle: null, reason: "OWNER_ID_REQUIRED" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { acquired: true, handle: writeNewLock(lockPath, ownerIdHash), reason: null };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const status = reclaimable(lockPath, staleAfterMs);
      if (!status.yes) return { acquired: false, handle: null, reason: status.reason };
      try { rmSync(lockPath); } catch (removeError) {
        if (removeError?.code !== "ENOENT") return { acquired: false, handle: null, reason: "LOCK_RECLAIM_RACE" };
      }
    }
  }
  return { acquired: false, handle: null, reason: "LOCK_RECLAIM_RACE" };
}

export function releaseAtomicLock(handle) {
  if (!handle?.path || !existsSync(handle.path)) return false;
  const record = readRecord(handle.path);
  if (!record || record.pid !== handle.pid || record.ownerIdHash !== handle.ownerIdHash) return false;
  rmSync(handle.path, { force: true });
  return true;
}
