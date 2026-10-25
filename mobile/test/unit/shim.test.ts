import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openShimDatabase, splitStatements } from "../../src/platform/sqlite/BetterSqliteShim";
import type { ShimDatabase } from "../../src/platform/sqlite/types";
import { fakeOpConnection } from "../helpers/fakeOpSqlite";
import { MIGRATIONS } from "../../src/core/generated/migrations";
import { diffSqliteFingerprint, readSqliteFingerprint } from "../../src/core/schemaFingerprint";

let dir = "";
let db: ShimDatabase;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "motard-shim-"));
  db = openShimDatabase({ name: "t.db", connection: fakeOpConnection(path.join(dir, "t.db")) });
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("splitStatements", () => {
  it("keeps trigger bodies, strings and comments whole", () => {
    const parts = splitStatements(
      `CREATE TABLE a (x TEXT); -- c; d\nINSERT INTO a VALUES ('a;b');\n` +
        `CREATE TRIGGER t AFTER INSERT ON a WHEN 1 BEGIN SELECT CASE WHEN 1 THEN 1 END; INSERT INTO a VALUES ('z'); END;`,
    );
    expect(parts).toHaveLength(3);
    expect(parts[2]).toMatch(/^CREATE TRIGGER t[\s\S]*END$/);
  });

  it("every bundled migration splits into statements that build the committed schema", () => {
    const fresh = openShimDatabase({
      name: "m.db",
      connection: fakeOpConnection(path.join(dir, "m.db")),
    });
    for (const m of MIGRATIONS) fresh.exec(m.sql);
    const committed = JSON.parse(
      readFileSync(
        path.resolve(
          __dirname,
          "../../../backend/src/infrastructure/orm/sqlite/migrations/meta/schema-fingerprint.json",
        ),
        "utf8",
      ),
    );
    expect(diffSqliteFingerprint(committed, readSqliteFingerprint(fresh, 9))).toEqual([]);
    fresh.close();
  });
});

describe("BetterSqliteShim", () => {
  it("run / get / all / raw / pluck / iterate", () => {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amt INTEGER)");
    const ins = db.prepare("INSERT INTO t (name, amt) VALUES (?, ?)");
    expect(ins.run("a", 5)).toMatchObject({ changes: 1, lastInsertRowid: 1 });
    ins.run("b", 7);
    expect(db.prepare("SELECT * FROM t WHERE id = ?").get(2)).toEqual({ id: 2, name: "b", amt: 7 });
    expect(db.prepare("SELECT name FROM t ORDER BY id").all()).toEqual([
      { name: "a" },
      { name: "b" },
    ]);
    expect(db.prepare("SELECT id, name FROM t ORDER BY id").raw().all()).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect(db.prepare("SELECT amt FROM t ORDER BY id").pluck().all()).toEqual([5, 7]);
    expect([...db.prepare("SELECT id FROM t").iterate()]).toHaveLength(2);
    expect(db.prepare("SELECT 1").reader).toBe(true);
    expect(db.prepare("SELECT 1").readonly).toBe(true);
    expect(db.prepare("INSERT INTO t (name) VALUES ('x') RETURNING id").reader).toBe(true);
    expect(db.prepare("INSERT INTO t (name) VALUES ('x') RETURNING id").readonly).toBe(false);
    expect(db.prepare("UPDATE t SET amt = 1").readonly).toBe(false);
  });

  it("pragma, safe-range bigint parameters and large bigint as text", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    db.prepare("INSERT INTO t (name, amt) VALUES (?, ?)").run("big", 10n);
    expect(db.prepare("SELECT amt FROM t WHERE name = 'big'").get()).toEqual({ amt: 10 });
    db.prepare("INSERT INTO t (name, amt) VALUES (?, ?)").run("huge", 9007199254740993n);
    const huge = db.prepare("SELECT CAST(amt AS TEXT) AS s FROM t WHERE name = 'huge'").get() as {
      s: string;
    };
    expect(huge.s).toBe("9007199254740993"); // the parameter kept every digit
  });

  it("tracks inTransaction and rolls back a failing transaction()", () => {
    expect(db.inTransaction).toBe(false);
    db.exec("BEGIN IMMEDIATE");
    expect(db.inTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(db.inTransaction).toBe(false);
    const before = (db.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c;
    const failing = db.transaction(() => {
      db.prepare("INSERT INTO t (name) VALUES ('rolled')").run();
      throw new Error("boom");
    });
    expect(failing).toThrow("boom");
    expect((db.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c).toBe(before);
    expect(db.inTransaction).toBe(false);
  });

  it("user-defined functions are reported as UDF_UNSUPPORTED (S1-4 / fallback F1-a)", () => {
    expect(() => db.function("f", () => 1)).toThrow("UDF_UNSUPPORTED");
    expect(() => db.aggregate("g", { step: (t) => t })).toThrow("UDF_UNSUPPORTED");
  });
});
