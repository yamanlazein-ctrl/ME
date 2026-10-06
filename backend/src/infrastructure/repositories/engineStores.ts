/**
 * Engine-selected stores for application modules that are plain functions
 * (not DI-constructed): each getter returns the implementation for the active
 * DB_ENGINE, loading its module lazily so a SQLite process never imports the
 * PostgreSQL pool (specs/001-desktop-sqlite-engine S1).
 *
 * The SQLite twins (repositories/sqlite) take the handle that matches what the PG store was given:
 * the raw pool (independent commit) → sqliteIndependentDb(); the ambient `db` → the compat `db`.
 */
import { getEngine } from "../orm/engine.js";
import type { ISyncConflictStore } from "../../application/ports/ISyncConflictStore.js";
import type { ISyncRestoreStateStore } from "../../application/ports/ISyncRestoreStateStore.js";

const sqliteHandles = async () => {
  const [{ sqliteIndependentDb }, { db }] = await Promise.all([
    import("../orm/sqlite/transaction.js"),
    import("../orm/sqlite/drizzleCompat.js"),
  ]);
  return { independent: sqliteIndependentDb(), ambient: db };
};

let syncConflictStore: Promise<ISyncConflictStore> | null = null;
export function getSyncConflictStore(): Promise<ISyncConflictStore> {
  syncConflictStore ??= (async () => {
    if (getEngine() === "sqlite") {
      const [{ SqliteSyncConflictStore }, h] = await Promise.all([import("./sqlite/SqliteSyncConflictStore.js"), sqliteHandles()]);
      return new SqliteSyncConflictStore(h.independent);
    }
    const [{ pool }, { PostgresSyncConflictStore }] = await Promise.all([
      import("../orm/drizzle.js"),
      import("./PostgresSyncConflictStore.js"),
    ]);
    return new PostgresSyncConflictStore(pool);
  })();
  return syncConflictStore;
}

import type { ISyncMaterializeStore } from "../../application/ports/ISyncMaterializeStore.js";
let syncMaterializeStore: Promise<ISyncMaterializeStore> | null = null;
export function getSyncMaterializeStore(): Promise<ISyncMaterializeStore> {
  syncMaterializeStore ??= (async () => {
    if (getEngine() === "sqlite") {
      const [{ SqliteSyncMaterializeStore }, h] = await Promise.all([import("./sqlite/SqliteSyncMaterializeStore.js"), sqliteHandles()]);
      return new SqliteSyncMaterializeStore(h.independent);
    }
    const [{ pool }, { PostgresSyncMaterializeStore }] = await Promise.all([
      import("../orm/drizzle.js"),
      import("./PostgresSyncMaterializeStore.js"),
    ]);
    return new PostgresSyncMaterializeStore(pool);
  })();
  return syncMaterializeStore;
}

import type { ISyncStateStore } from "../../application/ports/ISyncStateStore.js";
let syncStateStore: Promise<ISyncStateStore> | null = null;
export function getSyncStateStore(): Promise<ISyncStateStore> {
  syncStateStore ??= (async () => {
    if (getEngine() === "sqlite") {
      const [{ SqliteSyncStateStore }, h] = await Promise.all([import("./sqlite/SqliteSyncStateStore.js"), sqliteHandles()]);
      return new SqliteSyncStateStore(h.ambient);
    }
    const [{ db }, { PostgresSyncStateStore }] = await Promise.all([
      import("../orm/drizzle.js"),
      import("./PostgresSyncStateStore.js"),
    ]);
    return new PostgresSyncStateStore(db);
  })();
  return syncStateStore;
}

import type { INumberCollisionSql } from "../../application/ports/INumberCollisionSql.js";
let numberCollisionSql: Promise<INumberCollisionSql> | null = null;
export function getNumberCollisionSql(): Promise<INumberCollisionSql> {
  numberCollisionSql ??= (async () => {
    if (getEngine() === "sqlite") return (await import("./sqlite/SqliteNumberCollisionSql.js")).sqliteNumberCollisionSql;
    return (await import("./PostgresNumberCollisionSql.js")).postgresNumberCollisionSql;
  })();
  return numberCollisionSql;
}

import type { INumberBlockStore } from "../../application/ports/INumberBlockStore.js";
let numberBlockStore: Promise<INumberBlockStore> | null = null;
export function getNumberBlockStore(): Promise<INumberBlockStore> {
  numberBlockStore ??= (async () => {
    if (getEngine() === "sqlite") {
      const [{ SqliteNumberBlockStore }, h] = await Promise.all([import("./sqlite/SqliteNumberBlockStore.js"), sqliteHandles()]);
      return new SqliteNumberBlockStore(h.ambient);
    }
    const [{ db }, { PostgresNumberBlockStore }] = await Promise.all([
      import("../orm/drizzle.js"),
      import("./PostgresNumberBlockStore.js"),
    ]);
    return new PostgresNumberBlockStore(db);
  })();
  return numberBlockStore;
}

import type { ISyncDependencyStore } from "../../application/ports/ISyncDependencyStore.js";
let syncDependencyStore: Promise<ISyncDependencyStore> | null = null;
export function getSyncDependencyStore(): Promise<ISyncDependencyStore> {
  syncDependencyStore ??= (async () => {
    if (getEngine() === "sqlite") return (await import("./sqlite/SqliteSyncDependencyStore.js")).sqliteSyncDependencyStore;
    return (await import("./PostgresSyncDependencyStore.js")).postgresSyncDependencyStore;
  })();
  return syncDependencyStore;
}

import type { IDesktopActivationStore } from "../../application/ports/IDesktopActivationStore.js";
let desktopActivationStore: Promise<IDesktopActivationStore> | null = null;
export function getDesktopActivationStore(): Promise<IDesktopActivationStore> {
  desktopActivationStore ??= (async () => {
    if (getEngine() === "sqlite") {
      const [{ SqliteDesktopActivationStore }, h] = await Promise.all([import("./sqlite/SqliteDesktopActivationStore.js"), sqliteHandles()]);
      return new SqliteDesktopActivationStore(h.ambient);
    }
    const [{ db }, { PostgresDesktopActivationStore }] = await Promise.all([
      import("../orm/drizzle.js"),
      import("./PostgresDesktopActivationStore.js"),
    ]);
    return new PostgresDesktopActivationStore(db);
  })();
  return desktopActivationStore;
}

let syncRestoreStateStore: Promise<ISyncRestoreStateStore> | null = null;
/**
 * Restore-on-synced-device state (T109). SQLite desktops only: the restore writes it. PostgreSQL
 * (cloud / hub) never restores a device snapshot, so its store always reports "no restore".
 */
export function getSyncRestoreStateStore(): Promise<ISyncRestoreStateStore> {
  syncRestoreStateStore ??= (async () => {
    if (getEngine() === "sqlite") {
      const { SqliteSyncRestoreStateStore } = await import("./sqlite/SqliteSyncRestoreStateStore.js");
      return new SqliteSyncRestoreStateStore();
    }
    const none: ISyncRestoreStateStore = {
      get: async () => null,
      setRegistered: async () => {},
      addProgress: async () => {},
      setError: async () => {},
      markDone: async () => {},
    };
    return none;
  })();
  return syncRestoreStateStore;
}
