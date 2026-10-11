import { authorizeLeaseMutation } from "../leases/lease-authorizer.mjs";
import { normalizeAuthorizationActor } from "./capability-authorization.mjs";

const MUTATION_OPERATIONS = new Set([
  "WRITE",
  "MUTATE",
  "CREATE",
  "DELETE",
  "RENAME",
  "MOVE",
  "APPLY_PATCH",
]);

function token(value) {
  return typeof value === "string"
    ? value.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : "";
}

function workspaceId(workspace) {
  if (!workspace || typeof workspace !== "object") return "";
  const value = workspace.workspaceId ?? workspace.id;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Fences workspace mutation before provider-specific execution. This composes
 * the canonical Work Lease authorizer rather than creating a second authority
 * model, and accepts normalized provider actors (`actorIdHash`) at the edge.
 */
export function authorizeMutation({ actor, lease, generation, workspace, operation } = {}) {
  const normalizedOperation = token(operation);
  if (!normalizedOperation || normalizedOperation === "UNKNOWN") {
    return { allowed: false, reason: "UNKNOWN_OPERATION" };
  }
  if (!MUTATION_OPERATIONS.has(normalizedOperation)) {
    return { allowed: false, reason: "NOT_A_MUTATION" };
  }

  const expectedWorkspaceId = typeof lease?.workspaceId === "string" ? lease.workspaceId : "";
  const actualWorkspaceId = workspaceId(workspace);
  if (!expectedWorkspaceId || !actualWorkspaceId) {
    return { allowed: false, reason: "WORKSPACE_ID_INVALID" };
  }
  if (expectedWorkspaceId !== actualWorkspaceId) {
    return { allowed: false, reason: "WORKSPACE_ID_MISMATCH" };
  }

  const normalizedActor = normalizeAuthorizationActor(actor);
  if (!normalizedActor) {
    return { allowed: false, reason: "LEASE_IDENTITY_INVALID" };
  }

  return authorizeLeaseMutation({
    lease,
    actor: normalizedActor,
    generation,
    capability: "WORKSPACE_EDIT",
  });
}
