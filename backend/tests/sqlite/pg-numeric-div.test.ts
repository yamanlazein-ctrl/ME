/**
 * I-3: pgNumericDivide reproduces PostgreSQL `numeric / numeric` text exactly (result scale and
 * half-away-from-zero rounding), checked against a live PG on 20,000 seeded cases.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { pgNumericDivide } from "@/infrastructure/repositories/sqlite/helpers/pgNumericDiv.js";
import { formatScaled } from "@/infrastructure/orm/sqlite/types.js";

const PG_URL = process.env.TEST_DB_URL ?? process.env.DATABASE_URL;

describe.skipIf(!PG_URL)("pgNumericDivide vs PostgreSQL", () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
  });
  afterAll(async () => client?.end());

  it("matches PG text for 20,000 quotients across magnitudes and scales", async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const cases: Array<[bigint, number, bigint, number]> = [];
    for (let i = 0; i < 20000; i++) {
      const sa = [2, 4, 6][i % 3];
      const sb = [2, 2, 4][i % 3];
      const mag = (k: number) => BigInt(Math.floor(rnd() * 10 ** (1 + Math.floor(rnd() * k))));
      let a = mag(13) * (rnd() < 0.2 ? -1n : 1n);
      let b = mag(10) + 1n;
      if (i % 50 === 0) a = b * 3n; // exact quotients
      cases.push([a, sa, b, sb]);
    }
    for (let c = 0; c < cases.length; c += 2000) {
      const chunk = cases.slice(c, c + 2000);
      const r = await client.query<{ t: string }>(
        `SELECT (a::numeric / b::numeric)::text AS t
           FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS u(a, b, i) ORDER BY i`,
        [chunk.map(([a, sa]) => formatScaled(a, sa)), chunk.map(([, , b, sb]) => formatScaled(b, sb))],
      );
      chunk.forEach(([a, sa, b, sb], j) => {
        const mine = pgNumericDivide(a, sa, b, sb);
        if (mine !== r.rows[j].t) throw new Error(`${formatScaled(a, sa)} / ${formatScaled(b, sb)}: pg=${r.rows[j].t} mine=${mine}`);
      });
    }
    expect(pgNumericDivide(10n, 2, 0n, 2)).toBeNull();
  }, 120_000);
});

describe.skipIf(!PG_URL)("motard_pgdiv / motard_decsum app functions vs PostgreSQL", () => {
  it("SUM of per-row divisions equals PG's exact numeric SUM", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { registerNumericFunctions } = await import("@/infrastructure/orm/sqlite/numericFunctions.js");
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    const db = new Database(":memory:");
    registerNumericFunctions(db);
    db.exec("CREATE TABLE t (amt INTEGER, rate INTEGER, usd INTEGER)");
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const rows: Array<[bigint, bigint, number]> = [];
    for (let i = 0; i < 3000; i++) rows.push([BigInt(Math.floor(rnd() * 1e12)), BigInt(1 + Math.floor(rnd() * 2e10)), rnd() < 0.3 ? 1 : 0]);
    const ins = db.prepare("INSERT INTO t VALUES (?, ?, ?)");
    for (const r of rows) ins.run(r[0], r[1], r[2]);
    const mine = db.prepare(
      "SELECT motard_decsum(CASE WHEN usd = 1 THEN motard_dectext(amt, 4) ELSE motard_pgdiv(amt, 4, rate, 6) END) AS s FROM t",
    ).pluck().get();
    const r = await client.query<{ s: string }>(
      `SELECT sum(CASE WHEN u = 1 THEN a::numeric ELSE a::numeric / b::numeric END)::text AS s
         FROM unnest($1::text[], $2::text[], $3::int[]) AS x(a, b, u)`,
      [rows.map(([a]) => formatScaled(a, 4)), rows.map(([, b]) => formatScaled(b, 6)), rows.map(([, , u]) => u)],
    );
    await client.end();
    db.close();
    expect(mine).toBe(r.rows[0].s);
  });
});
