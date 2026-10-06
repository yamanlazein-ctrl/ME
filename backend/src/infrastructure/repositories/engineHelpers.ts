/**
 * Engine-selected SQL helper modules (specs/001-desktop-sqlite-engine S4).
 *
 * Routes and use cases that call a helper module directly (not through a DI repository) must get
 * the twin of the active DB_ENGINE: the PostgreSQL helper run against a SQLite transaction fails
 * on PG-only syntax. Each getter loads the module lazily; both twins export the same functions, so
 * the PostgreSQL module's type describes either.
 */
import { getEngine } from "../orm/engine.js";

type FinancialYear = typeof import("./financialYearRepository.js");
type InventoryCount = typeof import("./inventoryCountRepository.js");
type DyePurge = typeof import("./dyePurgeRepository.js");
type PartyDeletion = typeof import("./partyDeletionImpact.js");
type RollDeletion = typeof import("./rollDeletionHelper.js");

const pick = <T>(sqlite: () => Promise<unknown>, pg: () => Promise<unknown>): Promise<T> =>
  (getEngine() === "sqlite" ? sqlite() : pg()) as Promise<T>;

export const financialYearHelpers = () =>
  pick<FinancialYear>(() => import("./sqlite/helpers/financialYearRepository.js"), () => import("./financialYearRepository.js"));
export const inventoryCountHelpers = () =>
  pick<InventoryCount>(() => import("./sqlite/helpers/inventoryCountRepository.js"), () => import("./inventoryCountRepository.js"));
export const dyePurgeHelpers = () =>
  pick<DyePurge>(() => import("./sqlite/helpers/dyePurgeRepository.js"), () => import("./dyePurgeRepository.js"));
export const partyDeletionHelpers = () =>
  pick<PartyDeletion>(() => import("./sqlite/helpers/partyDeletionImpact.js"), () => import("./partyDeletionImpact.js"));
export const rollDeletionHelpers = () =>
  pick<RollDeletion>(() => import("./sqlite/helpers/rollDeletionHelper.js"), () => import("./rollDeletionHelper.js"));
