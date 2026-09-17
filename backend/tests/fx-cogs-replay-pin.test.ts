import { describe, expect, it } from "vitest";
import { resolveSaleCostPerKg } from "../src/domain/invoices/invoiceCostSnapshot.js";
import { pool } from "../src/infrastructure/orm/drizzle.js";
import { materializeSyncUnit } from "../src/application/use-cases/sync/syncMaterialize.js";
import { db } from "../src/infrastructure/orm/drizzle.js";
import { runWithTenantContext } from "../src/infrastructure/orm/tenant-context.js";

describe("historical sale cost pinning", () => {
  it("keeps a captured cost when the current roll price changes", () => {
    expect(resolveSaleCostPerKg(12.5, 99)).toBe(12.5);
    expect(resolveSaleCostPerKg(null, 7.25)).toBe(7.25);
    expect(resolveSaleCostPerKg(undefined, 3)).toBe(3);
  });

  it("live: stored invoice FX/COGS stay put after roll price change and create-replay", async () => {
    await pool.query("select 1");
    const row = await pool.query<{
      tenant_id: string;
      invoice_id: string;
      exchange_rate: string | null;
      cost_per_kg: string | null;
      roll_id: string;
      number: string;
      type: string;
    }>(`
      SELECT i.tenant_id::text, i.id::text AS invoice_id, i.exchange_rate::text, il.cost_per_kg::text,
             il.roll_id::text, i.number, i.type
        FROM invoices i
        JOIN invoice_lines il ON il.invoice_id = i.id
       WHERE i.status = 'active' AND i.type = 'sale' AND il.cost_per_kg IS NOT NULL
       LIMIT 1
    `);
    if (!row.rows[0]) {
      throw new Error("no sale invoice with cost_per_kg on live postgres — cannot pin FX/COGS");
    }
    const inv = row.rows[0];
    const before = {
      rate: inv.exchange_rate,
      cost: inv.cost_per_kg,
    };
    const rollBefore = await pool.query<{ p: string }>(
      `SELECT price_per_kg::text AS p FROM rolls WHERE id = $1`,
      [inv.roll_id],
    );
    const oldPrice = rollBefore.rows[0]?.p;
    if (oldPrice == null) throw new Error("roll missing");
    try {
      await pool.query(`UPDATE rolls SET price_per_kg = (price_per_kg::numeric + 111.11) WHERE id = $1`, [
        inv.roll_id,
      ]);
      const afterBump = await pool.query<{ exchange_rate: string | null; cost_per_kg: string | null }>(
        `SELECT i.exchange_rate::text, il.cost_per_kg::text
           FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id
          WHERE i.id = $1 AND il.roll_id = $2 LIMIT 1`,
        [inv.invoice_id, inv.roll_id],
      );
      expect(afterBump.rows[0]?.exchange_rate).toBe(before.rate);
      expect(afterBump.rows[0]?.cost_per_kg).toBe(before.cost);

      const ctx = {
        tenantId: inv.tenant_id,
        userId: "00000000-0000-4000-8000-000000000001",
        userName: "pin-test",
        userRole: "admin" as const,
      };
      const result = await runWithTenantContext({ tenantId: inv.tenant_id }, () =>
        materializeSyncUnit(
          db,
          {
            invoiceRepo: { findById: async () => ({ id: inv.invoice_id }) },
            auditRepo: { create: async () => undefined },
          } as never,
          {
            entityType: "invoice",
            operation: "create",
            payload: {
              invoiceId: inv.invoice_id,
              invoiceNumber: inv.number,
              invoiceType: inv.type,
            },
          },
          ctx,
        ),
      );
      expect(result.status).toBe("exists");
      const afterReplay = await pool.query<{ exchange_rate: string | null; cost_per_kg: string | null }>(
        `SELECT i.exchange_rate::text, il.cost_per_kg::text
           FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id
          WHERE i.id = $1 AND il.roll_id = $2 LIMIT 1`,
        [inv.invoice_id, inv.roll_id],
      );
      expect(afterReplay.rows[0]?.exchange_rate).toBe(before.rate);
      expect(afterReplay.rows[0]?.cost_per_kg).toBe(before.cost);
    } finally {
      await pool.query(`UPDATE rolls SET price_per_kg = $2 WHERE id = $1`, [inv.roll_id, oldPrice]);
    }
  });
});
