import { db } from "../src/infrastructure/orm/drizzle.js";
import { tenants } from "../src/infrastructure/orm/schemas/tenant.table.js";
import { invoices } from "../src/infrastructure/orm/schemas/invoice.table.js";

async function main() {
  console.log("=== All Tenants ===");
  const t = await db.select().from(tenants);
  for (const row of t) {
    console.log(`  id=${row.id}, name=${row.name}, slug=${row.slug}`);
  }

  console.log("\n=== Invoice tenant_ids ===");
  const invs = await db.select({ tenantId: invoices.tenantId }).from(invoices);
  const unique = new Set(invs.map((i) => i.tenantId));
  for (const tid of unique) {
    const count = invs.filter((i) => i.tenantId === tid).length;
    console.log(`  ${tid} -> ${count} invoices`);
  }

  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
