/**
 * T033 (specs/001-desktop-sqlite-engine): SQLite scaled-integer money columns
 * must store, read and SUM exactly like PostgreSQL numeric(p,s).
 *
 * For every live scale (schema fingerprint) 100,000 seeded random inputs —
 * raw doubles, x.xx5 half-way boundaries, negatives, exponent forms and
 * maximum magnitudes — are sent to PG exactly as node-pg sends them
 * (String(number)) and round-tripped through better-sqlite3 + Drizzle with
 * the SQLite column types. Number mode must equal Number(pgText), string mode
 * must equal pgText, chunk SUMs must equal PG sum(), and every overflow must
 * overflow on both engines.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { withExactIntegers } from "@/infrastructure/orm/sqlite/exactIntegers.js";
import { sqliteTable, integer } from "drizzle-orm/sqlite-core";
import { asc, sql } from "drizzle-orm";
import {
  numeric,
  decimalString,
  toScaledInteger,
  formatScaled,
  SqliteValueError,
} from "@/infrastructure/orm/sqlite/types.js";

const PG_URL = process.env.TEST_DB_URL ?? process.env.DATABASE_URL;
const PER_SCALE = 100_000;
const CHUNK = 20_000;
/** Live numeric types (schema-fingerprint.json). */
const SCALES: Array<[number, number]> = [
  [14, 2], [12, 2], [18, 6], [7, 2], [14, 4], [5, 4], [14, 3],
];

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inputs as the app would bind them: JS numbers (sent as String(n)) or decimal strings. */
function generate(p: number, s: number, seed: number): Array<number | string> {
  const rnd = mulberry32(seed);
  const intDigits = p - s;
  const max = 10 ** intDigits;
  const out: Array<number | string> = [];
  const sign = () => (rnd() < 0.5 ? -1 : 1);
  const intText = () => String(Math.floor(rnd() * Math.min(max, 1e15)));
  for (let i = 0; i < PER_SCALE; i++) {
    const kind = i % 10;
    if (kind <= 2) {
      // raw double across the whole magnitude range, full double digits
      out.push(sign() * rnd() * 10 ** (rnd() * intDigits));
    } else if (kind <= 4) {
      // half-way boundary x.xx5 at the column scale, as string and as number
      const frac = String(Math.floor(rnd() * 10 ** s)).padStart(s, "0");
      const t = `${sign() < 0 ? "-" : ""}${intText()}.${frac}5`;
      out.push(kind === 3 ? t : Number(t));
    } else if (kind === 5) {
      // more decimals than the scale
      out.push(Number((sign() * rnd() * 1000).toFixed(s + 1 + Math.floor(rnd() * 6))));
    } else if (kind === 6) {
      // tiny magnitudes → exponent notation ("1e-7")
      out.push(sign() * rnd() * 10 ** -(s + 1 + Math.floor(rnd() * 8)));
    } else if (kind === 7) {
      // largest representable magnitudes (just under 10^(p-s))
      const top = "9".repeat(intDigits) + "." + "9".repeat(s);
      out.push(rnd() < 0.5 ? `${sign() < 0 ? "-" : ""}${top}` : sign() * (max - 10 ** -s) * rnd() ** 0.01);
    } else if (kind === 8) {
      // integers and whole-number strings
      out.push(rnd() < 0.5 ? sign() * Math.floor(rnd() * Math.min(max, 1e15)) : `${intText()}`);
    } else {
      // exponent-form strings PG accepts
      out.push(`${(rnd() * 9 + 1).toFixed(5)}e${Math.floor(rnd() * Math.max(1, intDigits - 1))}`);
    }
  }
  return out;
}

const asPgText = (v: number | string) => String(v);

function overflows(v: number | string, p: number, s: number): boolean {
  try {
    toScaledInteger(v, p, s);
    return false;
  } catch (e) {
    if (e instanceof SqliteValueError && e.code === "22003") return true;
    throw e;
  }
}

describe.skipIf(!PG_URL)("SQLite numeric(p,s) parity with PostgreSQL (T033)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  for (const [p, s] of SCALES) {
    it(`numeric(${p},${s}): ${PER_SCALE.toLocaleString("en")} values round-trip and SUM identically`, async () => {
      const inputs = generate(p, s, p * 100 + s);
      const fits = inputs.filter((v) => !overflows(v, p, s));
      const over = inputs.filter((v) => overflows(v, p, s));

      // SQLite: real round-trip through better-sqlite3 + Drizzle column types.
      const raw = new Database(":memory:");
      raw.exec("CREATE TABLE m (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)");
      const m = sqliteTable("m", {
        id: integer("id").primaryKey(),
        n: numeric("n", { precision: p, scale: s }).notNull(),
        t: decimalString("t", { precision: p, scale: s }).notNull(),
      });
      const db = drizzle(withExactIntegers(raw));
      db.transaction((tx) => {
        for (let i = 0; i < fits.length; i += 500) {
          tx.insert(m)
            .values(fits.slice(i, i + 500).map((v, j) => ({ id: i + j, n: v as number, t: v as string })))
            .run();
        }
      });
      const back = db.select().from(m).orderBy(asc(m.id)).all();
      expect(back).toHaveLength(fits.length);

      for (let c = 0; c < fits.length; c += CHUNK) {
        const slice = fits.slice(c, c + CHUNK);
        const r = await client.query<{ t: string }>(
          `SELECT v::numeric(${p},${s})::text AS t
             FROM unnest($1::text[]) WITH ORDINALITY AS u(v, i) ORDER BY i`,
          [slice.map(asPgText)],
        );
        for (let j = 0; j < slice.length; j++) {
          const pgText = r.rows[j].t;
          const row = back[c + j];
          if (row.t !== pgText || row.n !== Number(pgText)) {
            throw new Error(
              `numeric(${p},${s}) mismatch for input ${JSON.stringify(slice[j])}: pg=${pgText} sqlite=${row.t}/${row.n}`,
            );
          }
        }
        // SUM of the chunk: SQLite integer SUM vs PG numeric sum. SQLite's SUM is
        // exact int64 and raises "integer overflow" when a running total leaves
        // ±2^63 scaled units (allowed delta: an error, never a wrong value).
        const ids = [c, c + slice.length - 1];
        const sumStmt = raw.prepare("SELECT sum(t) AS s FROM m WHERE id BETWEEN ? AND ?").safeIntegers(true);
        const ps = await client.query<{ s: string }>(
          `SELECT sum(v::numeric(${p},${s}))::text AS s FROM unnest($1::text[]) AS u(v)`,
          [slice.map(asPgText)],
        );
        let running = 0n;
        let peak = 0n;
        for (const v of slice) {
          running += toScaledInteger(v, p, s);
          const a = running < 0n ? -running : running;
          if (a > peak) peak = a;
        }
        if (peak < 2n ** 63n) {
          const sq = sumStmt.get(...ids) as { s: bigint };
          expect(formatScaled(sq.s, s)).toBe(ps.rows[0].s);
        } else {
          expect(() => sumStmt.get(...ids)).toThrow(/integer overflow/);
          // Within int64 the same values still SUM exactly: compare 5-row windows.
          for (let w = 0; w < 50; w++) {
            const win = slice.slice(w * 5, w * 5 + 5);
            const sq = sumStmt.get(c + w * 5, c + w * 5 + win.length - 1) as { s: bigint };
            const pw = await client.query<{ s: string }>(
              `SELECT sum(v::numeric(${p},${s}))::text AS s FROM unnest($1::text[]) AS u(v)`,
              [win.map(asPgText)],
            );
            expect(formatScaled(sq.s, s)).toBe(pw.rows[0].s);
          }
        }
      }

      // Overflow parity: everything SQLite refuses, PG refuses with 22003.
      for (const v of over.slice(0, 200)) {
        await expect(client.query(`SELECT $1::numeric(${p},${s})`, [asPgText(v)])).rejects.toMatchObject({ code: "22003" });
      }
      // And the boundary itself: the largest value fits, one unit more overflows.
      const top = "9".repeat(p - s) + (s ? "." + "9".repeat(s) : "");
      expect(formatScaled(toScaledInteger(top, p, s), s)).toBe(
        (await client.query<{ t: string }>(`SELECT $1::numeric(${p},${s})::text AS t`, [top])).rows[0].t,
      );
      const past = top + "5"; // rounds up to 10^(p-s)
      expect(overflows(past, p, s)).toBe(true);
      await expect(client.query(`SELECT $1::numeric(${p},${s})`, [past])).rejects.toMatchObject({ code: "22003" });

      raw.close();
    }, 120_000);
  }

  it("Drizzle writes through the same path as PG for drizzle-level SUM()", () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE m (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    const m = sqliteTable("m", { id: integer("id").primaryKey(), n: numeric("n", { precision: 14, scale: 2 }).notNull() });
    const db = drizzle(withExactIntegers(raw));
    db.insert(m).values([{ id: 1, n: 0.1 }, { id: 2, n: 0.2 }, { id: 3, n: 1.005 }]).run();
    // 0.10 + 0.20 + 1.01 (String(1.005) = "1.005" rounds half away from zero) = 1.31 exactly.
    const r = db.select({ s: sql<number>`sum(${m.n})` }).from(m).get();
    expect(formatScaled(BigInt(r!.s), 2)).toBe("1.31");
    raw.close();
  });
});
