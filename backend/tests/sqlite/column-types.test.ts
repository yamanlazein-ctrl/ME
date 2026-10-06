/**
 * T032 (specs/001-desktop-sqlite-engine): the non-money SQLite column types
 * accept, normalize and reject inputs exactly like PostgreSQL, and read back
 * the values Drizzle-on-PG returns today. Compared against a live PG database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer } from "drizzle-orm/sqlite-core";
import {
  canonicalUuid,
  canonicalDate,
  canonicalInet,
  toBoolInteger,
  toJsonbText,
  timestamptz,
  nowDefault,
  SqliteValueError,
} from "@/infrastructure/orm/sqlite/types.js";
import { runWithTransactionClock, transactionTimestamp } from "@/infrastructure/orm/sqlite/clock.js";
import { withExactIntegers } from "@/infrastructure/orm/sqlite/exactIntegers.js";

const PG_URL = process.env.TEST_DB_URL ?? process.env.DATABASE_URL;

/** PG's verdict for one cast: its text output, or the SQLSTATE it raised. */
async function pgCast(client: pg.Client, value: string, type: string): Promise<{ ok: string } | { code: string }> {
  try {
    // inet: node-pg receives inet_out (host masks omitted), not the ::text form.
    const sel = type === "inet" ? `SELECT $1::inet AS t` : `SELECT $1::${type}::text AS t`;
    const r = await client.query<{ t: string }>(sel, [value]);
    return { ok: r.rows[0].t };
  } catch (e) {
    return { code: (e as { code: string }).code };
  }
}

function sqCast(fn: (v: string) => string | number, value: string): { ok: string } | { code: string } {
  try {
    return { ok: String(fn(value)) };
  } catch (e) {
    if (e instanceof SqliteValueError) return { code: e.code };
    throw e;
  }
}

describe.skipIf(!PG_URL)("SQLite column types match PostgreSQL input rules (T032)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  it("uuid: accepted spellings normalize to PG's canonical text; bad ones fail with 22P02", async () => {
    const id = "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11";
    const cases = [
      id, id.toLowerCase(), `{${id}}`, id.replace(/-/g, ""),
      "a0eebc999c0b4ef8bb6d6bb9bd380a11", "a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11",
      "not-a-uuid", "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1", "{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "",
      "a0eebc99--9c0b-4ef8-bb6d-6bb9bd380a11",
    ];
    for (const c of cases) expect(sqCast(canonicalUuid, c), c).toEqual(await pgCast(client, c, "uuid"));
  });

  it("date: ISO inputs normalize like PG; impossible dates fail like PG", async () => {
    const cases = ["2026-10-03", "2026-1-5", "2024-02-29", "2023-02-29", "2026-13-01", "2026-04-31", " 2026-10-03 ", "2026-00-10"];
    for (const c of cases) {
      const sq = sqCast(canonicalDate, c);
      const pgv = await pgCast(client, c, "date");
      if ("ok" in pgv) expect(sq, c).toEqual(pgv);
      else expect("code" in sq && sq.code.startsWith("220"), `${c} → ${JSON.stringify(sq)} vs ${pgv.code}`).toBe(true);
    }
    for (const bad of ["2026/10/03", "garbage"]) expect("code" in sqCast(canonicalDate, bad)).toBe(true);
  });

  it("boolean: PG's accepted spellings", async () => {
    for (const c of ["t", "true", "TRUE", "yes", "on", "1", "f", "false", "no", "off", "0", " true "]) {
      const pgv = await pgCast(client, c, "boolean");
      expect(String(toBoolInteger(c) === 1)).toBe("ok" in pgv && pgv.ok === "true" ? "true" : "false");
    }
    expect(sqCast((v) => toBoolInteger(v), "maybe")).toEqual(await pgCast(client, "maybe", "boolean"));
  });

  it("jsonb: stored text uses PG's key order, and parses to the same value", async () => {
    const values: unknown[] = [
      { b: 1, a: 2, aa: { zz: [3, { y: 1, x: 2 }], c: null }, "10": "n", "2": true },
      [{ kind: "x", id: 1 }, "s", 1.5, null],
      "plain string",
      { "é": 1, e: 2, ab: 3, b: 4 },
    ];
    for (const v of values) {
      const pgText = (await client.query<{ t: string }>("SELECT $1::jsonb::text AS t", [JSON.stringify(v)])).rows[0].t;
      const sq = toJsonbText(v);
      expect(JSON.stringify(JSON.parse(sq))).toBe(JSON.stringify(JSON.parse(pgText)));
      // PG text has spaces after ':' and ','; key order must match exactly.
      expect(sq).toBe(JSON.stringify(JSON.parse(pgText.replace(/^/, ""))));
    }
    await expect(client.query("SELECT $1::jsonb", [JSON.stringify({ s: "a\u0000b" })])).rejects.toMatchObject({ code: "22P05" });
    expect(() => toJsonbText({ s: "a\u0000b" })).toThrow(SqliteValueError);
  });

  it("inet: canonical output matches PG", async () => {
    const cases = [
      "127.0.0.1", "10.0.0.1/24", "10.0.0.1/32", "::1", "::ffff:127.0.0.1", "2001:DB8:0:0:0:0:0:1",
      "2001:db8:0:1:0:0:0:1", "2001:0db8:0000:0000:0001:0000:0000:0001", "fe80::1/64", "::", "1:0:2::3",
      "1:2:3:4:5:6:0:8", "::/0", "1::", "::2:3:4:5:6:7:8", "not-an-ip", "300.1.1.1", "10.0.0.1/33",
    ];
    for (const c of cases) expect(sqCast(canonicalInet, c), c).toEqual(await pgCast(client, c, "inet"));
  });

  it("timestamptz: written like Drizzle-PG (ms) and read back as the same Date", async () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, at TEXT NOT NULL)");
    const t = sqliteTable("t", { id: integer("id").primaryKey(), at: timestamptz("at").notNull() });
    const db = drizzle(withExactIntegers(raw));
    const d = new Date("2026-10-03T12:34:56.789Z");
    db.insert(t).values({ id: 1, at: d }).run();
    expect((raw.prepare("SELECT at FROM t").get() as { at: string }).at).toBe("2026-10-03T12:34:56.789000Z");
    const pgRead = new Date(
      (await client.query<{ t: string }>("SELECT $1::timestamptz::text AS t", [d.toISOString()])).rows[0].t,
    );
    expect(db.select().from(t).get()!.at.getTime()).toBe(pgRead.getTime());
    raw.close();
  });

  it("timestamp defaults come from one fixed, strictly increasing µs transaction clock", () => {
    const a = runWithTransactionClock(() => [transactionTimestamp(), transactionTimestamp(), nowDefault()]);
    expect(new Set(a.map(String)).size).toBe(1);
    expect(a[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const seq = Array.from({ length: 2000 }, () => runWithTransactionClock(() => transactionTimestamp()));
    for (let i = 1; i < seq.length; i++) expect(seq[i] > seq[i - 1]).toBe(true);
  });
});

describe("exact int64 reads (withExactIntegers)", () => {
  it("returns plain numbers inside ±2^53 and exact bigints outside", () => {
    const raw = new Database(":memory:");
    const db = withExactIntegers(raw);
    db.exec("CREATE TABLE x (id INTEGER PRIMARY KEY, v INTEGER, s TEXT)");
    db.prepare("INSERT INTO x (v, s) VALUES (?, ?)").run(42, "a");
    db.prepare("INSERT INTO x (v, s) VALUES (?, ?)").run(704348507802965168n, "b");
    const rows = db.prepare("SELECT id, v, s FROM x ORDER BY id").all() as Array<{ id: unknown; v: unknown; s: unknown }>;
    expect(rows[0]).toEqual({ id: 1, v: 42, s: "a" });
    expect(rows[1].v).toBe(704348507802965168n);
    expect(db.prepare("SELECT count(*) FROM x").pluck().get()).toBe(2);
    const raws = db.prepare("SELECT id, v FROM x ORDER BY id").raw().all() as unknown[][];
    expect(raws[0]).toEqual([1, 42]);
    const info = db.prepare("INSERT INTO x (v) VALUES (1)").run();
    expect(info.lastInsertRowid).toBe(3);
    raw.close();
  });
});
