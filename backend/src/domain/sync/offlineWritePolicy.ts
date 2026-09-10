import type { Role } from "../../domain/types/index.js";

/**
 * Offline write trust matrix (product decision):
 * admin + accountant may create/mutate while offline;
 * warehouse + viewer are read-only until the hub is reachable again.
 */
export function canWriteOffline(role: Role | string): boolean {
  return role === "admin" || role === "accountant";
}
