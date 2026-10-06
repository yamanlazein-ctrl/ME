/**
 * T040 (specs/001-desktop-sqlite-engine): the SQLite trigger equivalents T1–T7 behave
 * exactly like the live PostgreSQL triggers.
 *
 * The same seeded sequence of ledger inserts, cancellations, attempted re-activations,
 * manual-movement inserts/updates/deletes and opening-balance seeding runs on both engines
 * (PG inside a transaction that is rolled back). Afterwards `cashbox_daily_balances` must
 * be identical row for row, every forbidden mutation must fail with the same message on
 * both engines, and `applied_seq` must be strictly increasing in commit order.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Database from "better-sqlite3";
import { toScaledInteger, formatScaled } from "@/infrastructure/orm/sqlite/types.js";
import { formatMicrosUtc, nextMonotonicMicros, transactionTimestamp } from "@/infrastructure/orm/sqlite/clock.js";

const PG_URL = process.env.TEST_DB_URL ?? process.env.DATABASE_URL;
const BASELINE = join(__dirname, "../../src/infrastructure/orm/sqlite/migrations/0000_baseline.sql");

/** Minimal two-engine adapter: SQL uses `?` placeholders; money values are passed as decimal text. */
interface Engine {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs `sql`; returns the error message, or null if it succeeded. Never leaves a broken transaction. */
  attempt(sql: string, params?: unknown[]): Promise<string | null>;
  setFlag(name: string, on: boolean): Promise<void>;
  money(v: string): unknown;
}

function sqliteEngine(): Engine & { db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("trusted_schema = OFF"); // production setting: the schema calls no app functions
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(BASELINE, "utf8"));
  db.prepare(`UPDATE motard_tx_state SET ts = ?`).run(transactionTimestamp());
  return {
    db,
    async run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async attempt(sql, params = []) {
      try {
        db.prepare(sql).run(...params);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
    async setFlag(name, on) {
      if (!["allow_party_remap", "allow_dye_purge"].includes(name)) throw new Error(name);
      db.prepare(`UPDATE motard_tx_state SET ${name} = ?`).run(on ? 1 : 0);
    },
    money: (v) => Number(toScaledInteger(v, 14, 2)),
  };
}

function pgEngine(client: pg.Client): Engine {
  const toPg = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  let sp = 0;
  return {
    async run(sql, params = []) {
      await client.query(toPg(sql), params);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return (await client.query(toPg(sql), params)).rows as T[];
    },
    async attempt(sql, params = []) {
      const name = `sp_${++sp}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        await client.query(toPg(sql), params);
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return null;
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        return (e as Error).message;
      }
    },
    async setFlag(name, on) {
      await client.query("SELECT set_config($1, $2, true)", [`app.${name}`, on ? "1" : "0"]);
    },
    money: (v) => v,
  };
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Op =
  | { k: "ledger"; id: string; date: string; currency: string; impact: string; debit: string; credit: string; status: string }
  | { k: "cancel"; id: string }
  | { k: "reactivate"; id: string }
  | { k: "mm_insert"; id: string; date: string; currency: string; direction: string; amount: string }
  | { k: "mm_update"; id: string; date: string; currency: string; direction: string; amount: string }
  | { k: "mm_delete"; id: string };

/** One seeded scenario shared by both engines. */
function scenario(seed: number, n: number): Op[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const day = () => `2026-03-${String(1 + Math.floor(rnd() * 20)).padStart(2, "0")}`;
  const amount = () => (Math.floor(rnd() * 10_000_000) / 100).toFixed(2);
  const ledger: string[] = [];
  const cancelled: string[] = [];
  const mm: string[] = [];
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.45 || ledger.length === 0) {
      const id = randomUUID();
      const a = amount();
      const debitSide = rnd() < 0.5;
      ops.push({
        k: "ledger", id, date: day(), currency: pick(["SYP", "SYP", "USD"]), impact: pick(["in", "out", "none"]),
        debit: debitSide ? a : "0", credit: debitSide ? "0" : a, status: rnd() < 0.1 ? "cancelled" : "active",
      });
      ledger.push(id);
    } else if (r < 0.6) {
      const id = pick(ledger);
      ops.push({ k: "cancel", id });
      cancelled.push(id);
    } else if (r < 0.65 && cancelled.length) {
      ops.push({ k: "reactivate", id: pick(cancelled) });
    } else if (r < 0.82 || mm.length === 0) {
      const id = randomUUID();
      ops.push({ k: "mm_insert", id, date: day(), currency: pick(["SYP", "USD"]), direction: pick(["in", "out"]), amount: amount() });
      mm.push(id);
    } else if (r < 0.94) {
      ops.push({ k: "mm_update", id: pick(mm), date: day(), currency: pick(["SYP", "USD"]), direction: pick(["in", "out"]), amount: amount() });
    } else {
      const id = mm.splice(Math.floor(rnd() * mm.length), 1)[0];
      ops.push({ k: "mm_delete", id });
    }
  }
  return ops;
}

/** Applies the scenario; returns every outcome (null = ok, else the error message). */
async function play(e: Engine, tenant: string, ops: Op[]): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (const op of ops) {
    switch (op.k) {
      case "ledger":
        out.push(await e.attempt(
          `INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit, status)
           VALUES (?, ?, ?, 'cash', ?, ?, ?, ?, ?)`,
          [op.id, tenant, op.date, op.currency, op.impact, e.money(op.debit), e.money(op.credit), op.status],
        ));
        break;
      case "cancel":
        out.push(await e.attempt(`UPDATE ledger_entries SET status = 'cancelled' WHERE id = ?`, [op.id]));
        break;
      case "reactivate":
        out.push(await e.attempt(`UPDATE ledger_entries SET status = 'active' WHERE id = ?`, [op.id]));
        break;
      case "mm_insert":
        out.push(await e.attempt(
          `INSERT INTO manual_movements (id, tenant_id, date, type, direction, amount, currency) VALUES (?, ?, ?, 'adjustment', ?, ?, ?)`,
          [op.id, tenant, op.date, op.direction, e.money(op.amount), op.currency],
        ));
        break;
      case "mm_update":
        out.push(await e.attempt(
          `UPDATE manual_movements SET date = ?, currency = ?, direction = ?, amount = ? WHERE id = ?`,
          [op.date, op.currency, op.direction, e.money(op.amount), op.id],
        ));
        break;
      case "mm_delete":
        out.push(await e.attempt(`DELETE FROM manual_movements WHERE id = ?`, [op.id]));
        break;
    }
  }
  return out;
}

async function setupTenant(e: Engine, tenant: string, slug: string) {
  await e.run(`INSERT INTO tenants (id, name, slug) VALUES (?, 'Trigger parity', ?)`, [tenant, slug]);
  // Opening balance for SYP only: the first SYP day seeds from it, USD from 0.
  await e.run(`INSERT INTO cashbox_sessions (id, tenant_id, opening_balance, opening_date, currency) VALUES (?, ?, ?, '2026-03-01', 'SYP')`, [
    randomUUID(), tenant, e.money("1000.00"),
  ]);
}

describe.skipIf(!PG_URL)("SQLite trigger equivalents match PostgreSQL (T040)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    await client.query("BEGIN");
  });
  afterAll(async () => {
    await client?.query("ROLLBACK").catch(() => {});
    await client?.end();
  });

  it("cashbox_daily_balances is identical row for row after the same 400 operations", async () => {
    const tenant = randomUUID();
    const slug = `trg-${tenant.slice(0, 8)}`;
    const ops = scenario(20261003, 400);
    const pgE = pgEngine(client);
    const sqE = sqliteEngine();
    await setupTenant(pgE, tenant, slug);
    await setupTenant(sqE, tenant, slug);
    const pgOut = await play(pgE, tenant, ops);
    const sqOut = await play(sqE, tenant, ops);
    expect(sqOut).toEqual(pgOut); // same successes, same failure messages, in the same places
    expect(pgOut.filter((x) => x !== null).length).toBeGreaterThan(0); // re-activations were refused

    const pgRows = await pgE.all<{ currency: string; d: string; b: string }>(
      `SELECT currency, balance_date::text AS d, closing_balance::text AS b FROM cashbox_daily_balances WHERE tenant_id = ? ORDER BY currency, balance_date`,
      [tenant],
    );
    const sqRows = (await sqE.all<{ currency: string; d: string; b: number }>(
      `SELECT currency, balance_date AS d, closing_balance AS b FROM cashbox_daily_balances WHERE tenant_id = ? ORDER BY currency, balance_date`,
      [tenant],
    )).map((r) => ({ ...r, b: formatScaled(BigInt(r.b), 2) }));
    expect(pgRows.length).toBeGreaterThan(10);
    expect(sqRows).toEqual(pgRows);
    sqE.db.close();
  }, 120_000);

  it("forbidden ledger and licence-audit mutations fail with the same messages", async () => {
    const tenant = randomUUID();
    const pgE = pgEngine(client);
    const sqE = sqliteEngine();
    const party = randomUUID();
    const party2 = randomUUID();
    const id = randomUUID();
    const cancelledId = randomUUID();
    const results: Record<string, Array<string | null>> = {};
    for (const [label, e] of [["pg", pgE], ["sq", sqE]] as const) {
      await setupTenant(e, tenant, `forbid-${label}-${tenant.slice(0, 8)}`);
      for (const p of [party, party2]) {
        await e.run(`INSERT INTO parties (id, tenant_id, kind, name) VALUES (?, ?, 'customer', ?)`, [p, tenant, `P ${p.slice(0, 6)}`]);
      }
      await e.run(
        `INSERT INTO ledger_entries (id, tenant_id, party_id, date, type, currency, cash_impact, debit, credit, reference_id, reference_type)
         VALUES (?, ?, ?, '2026-03-05', 'sales_invoice', 'SYP', 'none', ?, ?, NULL, 'invoice')`,
        [id, tenant, party, e.money("150.00"), e.money("0")],
      );
      await e.run(
        `INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit, status) VALUES (?, ?, '2026-03-05', 'cash', 'SYP', 'in', ?, ?, 'cancelled')`,
        [cancelledId, tenant, e.money("10.00"), e.money("0")],
      );
      const r: Array<string | null> = [];
      r.push(await e.attempt(`DELETE FROM ledger_entries WHERE id = ?`, [id]));
      r.push(await e.attempt(`UPDATE ledger_entries SET debit = ? WHERE id = ?`, [e.money("151.00"), id]));
      r.push(await e.attempt(`UPDATE ledger_entries SET debit = ?, status = 'cancelled' WHERE id = ?`, [e.money("151.00"), id]));
      r.push(await e.attempt(`UPDATE ledger_entries SET party_id = ? WHERE id = ?`, [party2, id]));
      r.push(await e.attempt(`UPDATE ledger_entries SET status = 'active' WHERE id = ?`, [cancelledId]));
      r.push(await e.attempt(`UPDATE ledger_entries SET reference_type = 'voucher', status = 'cancelled' WHERE id = ?`, [id]));
      // Controlled remap (merge): party_id only, with the flag.
      await e.setFlag("allow_party_remap", true);
      r.push(await e.attempt(`UPDATE ledger_entries SET party_id = ? WHERE id = ?`, [party2, id]));
      r.push(await e.attempt(`UPDATE ledger_entries SET party_id = ?, debit = ? WHERE id = ?`, [party, e.money("1.00"), id]));
      await e.setFlag("allow_party_remap", false);
      r.push(await e.attempt(`UPDATE ledger_entries SET status = 'cancelled' WHERE id = ?`, [id]));
      r.push(await e.attempt(`UPDATE ledger_entries SET description = 'x' WHERE id = ?`, [id]));
      // Licence audit events: append-only.
      const ev = randomUUID();
      await e.run(`INSERT INTO license_audit_events (event_type, tenant_id, payload) VALUES (?, ?, ?)`, [`parity-${ev}`, tenant, JSON.stringify({ ev })]);
      r.push(await e.attempt(`UPDATE license_audit_events SET event_type = 'x' WHERE event_type = ?`, [`parity-${ev}`]));
      r.push(await e.attempt(`DELETE FROM license_audit_events WHERE event_type = ?`, [`parity-${ev}`]));
      results[label] = r;
    }
    expect(results.sq).toEqual(results.pg);
    // Spot-check that the expected guards actually fired on PG.
    expect(results.pg[0]).toBe("ledger_entries is append-only: DELETE not allowed");
    expect(results.pg[4]).toBe("ledger_entries: cannot modify already-cancelled rows");
    expect(results.pg[6]).toBeNull(); // remap allowed
    expect(results.pg[10]).toBe("license_audit_events is append-only (operation UPDATE)");
    expect(results.pg[11]).toBe("license_audit_events is append-only (operation DELETE)");
    sqE.db.close();
  }, 60_000);
});

describe("SQLite-only trigger behavior", () => {
  it("allow_dye_purge permits ledger DELETE only; UPDATE stays guarded (research I-7)", async () => {
    const e = sqliteEngine();
    const tenant = randomUUID();
    await setupTenant(e, tenant, "dye");
    const id = randomUUID();
    await e.run(`INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit) VALUES (?, ?, '2026-03-02', 'cash', 'SYP', 'in', 500, 0)`, [id, tenant]);
    await e.setFlag("allow_dye_purge", true);
    expect(await e.attempt(`UPDATE ledger_entries SET debit = 600 WHERE id = ?`, [id])).toBe("ledger_entries: UPDATE only allowed for cancellation (status→cancelled)");
    expect(await e.attempt(`DELETE FROM ledger_entries WHERE id = ?`, [id])).toBeNull();
    await e.setFlag("allow_dye_purge", false);
    e.db.close();
  });

  it("the guard fails closed when motard_tx_state is missing its row (e.g. a foreign tool)", () => {
    const e = sqliteEngine();
    e.db.prepare(`INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit) VALUES (?, ?, '2026-03-02', 'cash', 'SYP', 'none', 1, 0)`).run(randomUUID(), randomUUID());
    e.db.prepare("DELETE FROM motard_tx_state").run();
    expect(() => e.db.prepare("DELETE FROM ledger_entries").run()).toThrow("ledger_entries is append-only: DELETE not allowed");
    e.db.close();
  });

  it("trigger-written timestamps use the transaction clock stamped in motard_tx_state", async () => {
    const e = sqliteEngine();
    const tenant = randomUUID();
    await setupTenant(e, tenant, "clock");
    const ts = formatMicrosUtc(nextMonotonicMicros());
    e.db.prepare("UPDATE motard_tx_state SET ts = ?").run(ts);
    await e.run(`INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit) VALUES (?, ?, '2026-03-02', 'cash', 'SYP', 'in', 500, 0)`, [randomUUID(), tenant]);
    expect(e.db.prepare("SELECT updated_at FROM cashbox_daily_balances WHERE tenant_id = ?").pluck().get(tenant)).toBe(ts);
    e.db.close();
  });

  it("applied_seq is stamped strictly increasing in commit order, with applied_at", () => {
    const e = sqliteEngine();
    const tenant = randomUUID();
    e.db.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'seq', 'seq')`).run(tenant);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = randomUUID();
      ids.push(id);
      e.db.prepare(
        `INSERT INTO sync_inbox (id, tenant_id, op_id, entity_type, entity_id, operation, payload, status, received_seq)
         VALUES (?, ?, ?, 'invoice', ?, 'create', '{}', ?, ?)`,
      ).run(id, tenant, randomUUID(), randomUUID(), i % 4 === 0 ? "applied" : "received", i + 1);
    }
    // Apply the rest in a shuffled order, one commit each.
    const order = ids.filter((_, i) => i % 4 !== 0).sort(() => 0.5 - Math.random());
    for (const id of order) e.db.transaction(() => e.db.prepare(`UPDATE sync_inbox SET status = 'applied' WHERE id = ?`).run(id))();
    // Re-applying an already-applied row must not restamp it.
    const before = e.db.prepare(`SELECT applied_seq FROM sync_inbox WHERE id = ?`).pluck().get(order[0]);
    e.db.prepare(`UPDATE sync_inbox SET status = 'applied' WHERE id = ?`).run(order[0]);
    expect(e.db.prepare(`SELECT applied_seq FROM sync_inbox WHERE id = ?`).pluck().get(order[0])).toBe(before);
    const commitOrder = [...ids.filter((_, i) => i % 4 === 0), ...order];
    const seqs = commitOrder.map((id) => e.db.prepare(`SELECT applied_seq, applied_at FROM sync_inbox WHERE id = ?`).get(id) as { applied_seq: number; applied_at: string });
    for (let i = 1; i < seqs.length; i++) expect(seqs[i].applied_seq).toBeGreaterThan(seqs[i - 1].applied_seq);
    expect(seqs.every((s) => /Z$/.test(s.applied_at))).toBe(true);
    e.db.close();
  });
});
