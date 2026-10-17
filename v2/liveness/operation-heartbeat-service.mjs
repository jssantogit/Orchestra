import { createHash, timingSafeEqual } from "node:crypto";

function failure(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function sha256Token(token) {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function sameDigest(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left.toLowerCase(), "utf8");
  const b = Buffer.from(right.toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createOperationHeartbeatService({ state, runtimeOwnerStore } = {}) {
  if (typeof state?.operations?.inspect !== "function" || typeof state?.operations?.heartbeat !== "function") {
    throw new TypeError("state.operations inspect/heartbeat are required");
  }
  if (typeof runtimeOwnerStore?.read !== "function") {
    throw new TypeError("runtimeOwnerStore.read is required");
  }

  return Object.freeze({
    async heartbeat({ operationId, ownerToken, heartbeatAt } = {}) {
      const operation = state.operations.inspect(operationId);
      if (!operation) return failure("OPERATION_NOT_FOUND");
      if (operation.liveness === "TERMINAL") return failure("OPERATION_TERMINAL");
      if (typeof operation.runtimeOwnerRef !== "string" || operation.runtimeOwnerRef.trim().length === 0) {
        return failure("RUNTIME_OWNER_MISSING");
      }

      let runtimeOwner;
      try {
        runtimeOwner = await runtimeOwnerStore.read(operation.runtimeOwnerRef);
      } catch {
        return failure("RUNTIME_OWNER_STORE_ERROR");
      }
      if (!runtimeOwner) return failure("RUNTIME_OWNER_MISSING");
      if (runtimeOwner.runtimeOwnerId !== operation.runtimeOwnerRef) {
        return failure("OWNER_REFERENCE_MISMATCH");
      }
      if (runtimeOwner.operationId !== operationId) {
        return failure("OWNER_OPERATION_MISMATCH");
      }
      if (typeof ownerToken !== "string" || ownerToken.length === 0) {
        return failure("OWNER_PROOF_MISMATCH");
      }

      const actualHash = sha256Token(ownerToken);
      if (!sameDigest(actualHash, runtimeOwner.proof?.tokenHash)) {
        return failure("OWNER_PROOF_MISMATCH");
      }

      return state.operations.heartbeat({
        operationId,
        runtimeOwnerRef: runtimeOwner.runtimeOwnerId,
        heartbeatAt,
      });
    },
  });
}
