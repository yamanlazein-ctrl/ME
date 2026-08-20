/**
 * Inspect current database state for parties, fabrics, colors, rolls
 */
import { db } from "../src/infrastructure/orm/drizzle.js";
import { eq } from "drizzle-orm";
import { parties } from "../src/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "../src/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "../src/infrastructure/orm/schemas/color.table.js";
import { rolls } from "../src/infrastructure/orm/schemas/roll.table.js";
import { invoices } from "../src/infrastructure/orm/schemas/invoice.table.js";

const TENANT_ID = "407fccfc-1234-5678-9abc-def012345678";

async function main() {
  console.log("=== Suppliers ===");
  const suppliers = await db.select().from(parties).where(eq(parties.kind, "supplier"));
  for (const s of suppliers) {
    console.log(`  ${s.name} (id=${s.id}, code=${s.code ?? "null"})`);
  }

  console.log("\n=== Fabrics ===");
  const fabRows = await db.select().from(fabrics);
  for (const f of fabRows) {
    console.log(`  ${f.name} (id=${f.id})`);
  }

  console.log("\n=== Colors ===");
  const colorRows = await db.select().from(colors);
  for (const c of colorRows.slice(0, 20)) {
    console.log(`  ${c.name} (id=${c.id}, fabric=${c.fabricId})`);
  }

  console.log("\n=== Rolls ===");
  const rollRows = await db.select().from(rolls).limit(20);
  for (const r of rollRows) {
    console.log(
      `  roll_no=${r.rollNo}, color=${r.colorId}, remaining=${r.remainingKg}, price=${r.pricePerKg}`,
    );
  }

  console.log("\n=== Recent Invoices ===");
  const invRows = await db.select().from(invoices).orderBy(invoices.createdAt).limit(10);
  for (const i of invRows) {
    console.log(
      `  ${i.number} type=${i.type} party=${i.partyId} total=${i.total} paid=${i.paid} method=${i.paymentMethod ?? "null"}`,
    );
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
