import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const SCHEMA = "orchestra.delegated-child-terminal.v1";
const ENVELOPE = "orchestra.delegated-child-terminal-record.v1";
const FIELDS = ["schema", "operationId", "runtimeOwnerId", "process", "terminal"];
const PROCESS = ["pid", "startIdentity"];
const TERMINAL = ["exitCode", "signal", "timedOut", "closedAt"];

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
function nonempty(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function json(value) { return JSON.stringify(canonical(value)); }
function hash(value) {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function corrupt(detail) {
  const error = new Error("ORCHESTRA_DELEGATED_CHILD_TERMINAL_CORRUPT:" + detail);
  error.code = "ORCHESTRA_DELEGATED_CHILD_TERMINAL_CORRUPT";
  return error;
}
function valid(record) {
  if (!exact(record, FIELDS) || record.schema !== SCHEMA
    || !nonempty(record.operationId) || !nonempty(record.runtimeOwnerId)
    || record.runtimeOwnerId !== "owner_delegated_child_" + record.operationId
    || !exact(record.process, PROCESS)
    || !Number.isSafeInteger(record.process.pid) || record.process.pid <= 0
    || !nonempty(record.process.startIdentity)
    || !exact(record.terminal, TERMINAL)) return false;
  const { exitCode, signal, timedOut, closedAt } = record.terminal;
  if (!Number.isFinite(Date.parse(closedAt)) || typeof timedOut !== "boolean"
    || !(exitCode === null || (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255))
    || !(signal === null || nonempty(signal))
    || (exitCode === null && signal === null)
    || (exitCode !== null && signal !== null)
    || (timedOut && exitCode !== null)) return false;
  return true;
}
function fileFor(root, operationId) {
  const key = createHash("sha256").update(operationId).digest("hex");
  return {
    dir: join(root, key.slice(0, 2)),
    path: join(root, key.slice(0, 2), key + ".json"),
  };
}

export function createDelegatedChildTerminalStore({ home, runtimeOwnerStore } = {}) {
  if (!nonempty(home) || typeof runtimeOwnerStore?.read !== "function") {
    throw new TypeError("DELEGATED_CHILD_TERMINAL_HOME_OWNER_REQUIRED");
  }
  const root = resolve(home, "delegation-child-terminals");

  async function ownerMatches(record) {
    let owner;
    try { owner = await runtimeOwnerStore.read(record.runtimeOwnerId); }
    catch { return false; }
    return owner?.schema === "orchestra.runtime-owner.v2"
      && owner.kind === "LOCAL_PROCESS"
      && owner.operationId === record.operationId
      && owner.runtimeOwnerId === record.runtimeOwnerId
      && owner.process?.pid === record.process.pid
      && owner.process?.startIdentity === record.process.startIdentity
      && Number.isFinite(Date.parse(owner.registeredAt))
      && Date.parse(record.terminal.closedAt) >= Date.parse(owner.registeredAt);
  }

  async function read(operationId) {
    if (!nonempty(operationId)) return null;
    const { path } = fileFor(root, operationId);
    let raw;
    try { raw = await readFile(path, "utf8"); }
    catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    let envelope;
    try { envelope = JSON.parse(raw); }
    catch { throw corrupt("INVALID_JSON"); }
    if (!exact(envelope, ["schema", "digest", "receipt"])
      || envelope.schema !== ENVELOPE
      || !valid(envelope.receipt)
      || envelope.receipt.operationId !== operationId
      || envelope.digest !== hash(json(envelope.receipt))
      || !(await ownerMatches(envelope.receipt))) {
      throw corrupt("INVALID_RECEIPT");
    }
    return clone(envelope.receipt);
  }

  async function register(record) {
    if (!valid(record) || !(await ownerMatches(record))) {
      return { ok: false, reason: "DELEGATED_CHILD_TERMINAL_UNVERIFIED" };
    }
    const previous = await read(record.operationId);
    if (previous) {
      return json(previous) === json(record)
        ? { ok: true, replayed: true, receipt: previous }
        : { ok: false, reason: "DELEGATED_CHILD_TERMINAL_CONFLICT" };
    }
    const { dir, path } = fileFor(root, record.operationId);
    await mkdir(dir, { recursive: true });
    const temp = join(dir, "." + randomUUID() + ".tmp");
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(JSON.stringify({
        schema: ENVELOPE, digest: hash(json(record)), receipt: clone(record),
      }) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      try { await link(temp, path); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const raced = await read(record.operationId);
        return raced && json(raced) === json(record)
          ? { ok: true, replayed: true, receipt: raced }
          : { ok: false, reason: "DELEGATED_CHILD_TERMINAL_CONFLICT" };
      }
      const saved = await read(record.operationId);
      if (!saved || json(saved) !== json(record)) {
        return { ok: false, reason: "DELEGATED_CHILD_TERMINAL_UNVERIFIED" };
      }
      return { ok: true, replayed: false, receipt: saved };
    } finally {
      if (handle) await handle.close();
      try { await unlink(temp); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }

  return Object.freeze({
    register, read,
    pathFor: operationId => fileFor(root, operationId).path,
  });
}
