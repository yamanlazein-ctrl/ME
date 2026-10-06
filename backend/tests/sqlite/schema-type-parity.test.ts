/**
 * T034 (specs/001-desktop-sqlite-engine): every SQLite table definition infers
 * exactly the PG Drizzle row types, so repository code is type-identical on both
 * engines. The assertions are compile-time (tsc); the runtime part checks that
 * every PG table export has a same-named SQLite export.
 */
import { describe, it, expect } from "vitest";
import { is, getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as pg from "@/infrastructure/orm/schemas/index.js";
import * as sq from "@/infrastructure/orm/sqlite/schemas/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type PgTables = { [K in keyof typeof pg as (typeof pg)[K] extends PgTable ? K : never]: (typeof pg)[K] };
type Select<T> = T extends { $inferSelect: infer S } ? S : never;
type Insert<T> = T extends { $inferInsert: infer I } ? I : never;
type SelectParity = {
  [K in keyof PgTables]: K extends keyof typeof sq ? Equal<Select<PgTables[K]>, Select<(typeof sq)[K]>> : "missing";
};
type InsertParity = {
  [K in keyof PgTables]: K extends keyof typeof sq ? Equal<Insert<PgTables[K]>, Insert<(typeof sq)[K]>> : "missing";
};
type Failing<P> = { [K in keyof P]: P[K] extends true ? never : K }[keyof P];
// If either line fails to compile, the error names the tables whose types differ.
const selectOk: Failing<SelectParity> extends never ? true : Failing<SelectParity> = true;
const insertOk: Failing<InsertParity> extends never ? true : Failing<InsertParity> = true;

describe("SQLite schema mirrors the PG Drizzle schema (T034)", () => {
  it("row types are identical (compile-time)", () => {
    expect(selectOk && insertOk).toBe(true);
  });

  it("every PG table export exists in SQLite with the same table name", () => {
    for (const [k, v] of Object.entries(pg)) {
      if (!is(v, PgTable)) continue;
      const s = (sq as Record<string, unknown>)[k];
      expect(is(s, SQLiteTable), k).toBe(true);
      expect(getTableName(s as SQLiteTable)).toBe(getTableName(v));
    }
    const sqTables = new Set(Object.values(sq).filter((v) => is(v, SQLiteTable)).map((v) => getTableName(v as SQLiteTable)));
    expect(sqTables.size).toBe(56); // 53 live + motard_meta + motard_sequences + motard_tx_state
    expect(sqTables.has("party_balances")).toBe(false);
  });
});
