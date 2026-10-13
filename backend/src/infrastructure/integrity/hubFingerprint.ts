import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getEngine } from "../orm/engine.js";
import { engineDb } from "../orm/engineSchema.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import { DEVICE_BOUND_TABLES } from "../backup/deviceBoundTables.js";

/**
 * MIG-04 — prove BEFORE devices are switched that the new server holds exactly the old server's
 * data. Take a fingerprint on the frozen old server and on the restored new one (same engine),
 * then compare (`compareFingerprints`, CLI `scripts/compare-hub-fingerprints.mts`).
 *
 * Per company: every table with a `tenant_id` (row count + sha256 of its rows in primary-key order),
 * party balances per currency from the active ledger, roll stock, and the head of the pull stream.
 * Tables a backup deliberately does not carry (machine-bound, portableBackup DEVICE_BOUND_TABLES)
 * and `secrets` are skipped — they differ by design. `audit_logs` changes with every sign-in, so a
 * difference there is a warning, not a failure.
 */
export type { HubFingerprint } from "./hubFingerprintCompare.js";
export { compareFingerprints } from "./hubFingerprintCompare.js";
import type { HubFingerprint } from "./hubFingerprintCompare.js";

const SKIPPED = new Set<string>([...DEVICE_BOUND_TABLES, "secrets"]);

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] =>
  (Array.isArray(r) ? r : ((r as { rows?: Row[] }).rows ?? [])) as Row[];
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function tenantTables(
  db: Awaited<ReturnType<typeof engineDb>>,
): Promise<Array<{ name: string; pk: string[]; cols: string[] }>> {
  const out: Array<{ name: string; pk: string[]; cols: string[] }> = [];
  if (getEngine() === "sqlite") {
    const names = rowsOf(
      await db.execute(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      ),
    ).map((r) => String(r.name));
    for (const name of names) {
      const info = rowsOf(await db.execute(sql.raw(`PRAGMA table_info(${ident(name)})`)));
      const cols = info.map((c) => String(c.name));
      if (!cols.includes("tenant_id")) continue;
      const pk = info
        .filter((c) => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((c) => String(c.name));
      out.push({ name, pk, cols });
    }
    return out;
  }
  const cols = rowsOf(
    await db.execute(sql`
      SELECT c.table_name AS t, c.column_name AS c
        FROM information_schema.columns c
        JOIN information_schema.tables tb
          ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public'
       ORDER BY c.table_name, c.ordinal_position`),
  );
  const pks = rowsOf(
    await db.execute(sql`
      SELECT k.table_name AS t, k.column_name AS c
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage k
          ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
       WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY k.table_name, k.ordinal_position`),
  );
  const byTable = new Map<string, string[]>();
  for (const r of cols)
    byTable.set(String(r.t), [...(byTable.get(String(r.t)) ?? []), String(r.c)]);
  for (const [name, list] of byTable) {
    if (!list.includes("tenant_id")) continue;
    out.push({
      name,
      cols: list,
      pk: pks.filter((p) => String(p.t) === name).map((p) => String(p.c)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function takeHubFingerprint(tenantId: string): Promise<HubFingerprint> {
  return runWithTenantContext({ tenantId }, async () => {
    const db = await engineDb();
    const tables: HubFingerprint["tables"] = {};
    for (const t of await tenantTables(db)) {
      if (SKIPPED.has(t.name)) continue;
      const order = (t.pk.length ? t.pk : t.cols).map(ident).join(", ");
      const rows = rowsOf(
        await db.execute(
          sql`SELECT * FROM ${sql.raw(ident(t.name))} WHERE tenant_id = ${tenantId} ORDER BY ${sql.raw(order)}`,
        ),
      );
      const h = createHash("sha256");
      for (const r of rows) h.update(JSON.stringify(r)).update("\n");
      tables[t.name] = { rows: rows.length, sha256: h.digest("hex") };
    }
    const balances = rowsOf(
      await db.execute(sql`
        SELECT party_id, currency, SUM(debit) - SUM(credit) AS balance FROM ledger_entries
         WHERE tenant_id = ${tenantId} AND status = 'active' AND party_id IS NOT NULL
         GROUP BY party_id, currency ORDER BY party_id, currency`),
    ).map((r) => ({
      partyId: String(r.party_id),
      currency: String(r.currency),
      balance: String(r.balance),
    }));
    const stock = rowsOf(
      await db.execute(sql`
        SELECT id, remaining_kg, remaining_pieces FROM rolls WHERE tenant_id = ${tenantId} ORDER BY id`),
    ).map((r) => ({
      rollId: String(r.id),
      remainingKg: String(r.remaining_kg),
      remainingPieces: String(r.remaining_pieces),
    }));
    const head = rowsOf(
      await db.execute(
        sql`SELECT MAX(applied_seq) AS m FROM sync_inbox WHERE tenant_id = ${tenantId} AND status = 'applied'`,
      ),
    )[0];
    const inboxByStatus: Record<string, number> = {};
    for (const r of rowsOf(
      await db.execute(
        sql`SELECT status, COUNT(*) AS n FROM sync_inbox WHERE tenant_id = ${tenantId} GROUP BY status ORDER BY status`,
      ),
    ))
      inboxByStatus[String(r.status)] = Number(r.n);
    return {
      tenantId,
      engine: getEngine(),
      takenAt: new Date().toISOString(),
      tables,
      balances,
      stock,
      stream: { headAppliedSeq: head?.m == null ? null : Number(head.m), inboxByStatus },
    };
  });
}
